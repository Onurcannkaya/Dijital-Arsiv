import { processNextOcrJob } from "../app/api/jobs/process/route.ts";
import { dispatchAlert } from "./alerts.ts";
import { runBackupSlice } from "./backup.ts";
import { runQuotaCheck } from "./capacity.ts";
import { processNextContentScanJob } from "./content-scan.ts";
import { assertSchemaReady, runMaintenanceSlice } from "./archive-schema.ts";
import { getPromotionStorages, type ArchiveBindings } from "./archive-storage.ts";
import { processNextPromotionJob } from "./ingest-promotion.ts";
import { storageInventory, storageReader, storageStaging, storageVaultWriter } from "./storage-roles.ts";
import { createDigestStreamHasher } from "./content-hasher.ts";
import { processNextDerivativeJob } from "./document-render.ts";
import { expireIncompleteUploads } from "./ingest-service.ts";
import { processNextKeyMigrationJob, runKeyInventorySlice } from "./key-migration.ts";
import { runIntegritySlice } from "./integrity.ts";
import { runReconciliationSlice } from "./reconciliation.ts";
import { logEvent, measured } from "./observability.ts";

export const CONTENT_SCAN_CRON = "* * * * *";
export const OCR_CRON = "*/2 * * * *";
export const MAINTENANCE_CRON = "*/5 * * * *";
export const INTEGRITY_CRON = "17 */6 * * *";

async function readQueueMetrics(db: D1Database) {
  const row = await db.prepare(`SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS depth,
      SUM(CASE WHEN status = 'queued' AND next_attempt_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS retry_wait,
      SUM(CASE WHEN status = 'failed' AND attempt >= max_attempts THEN 1 ELSE 0 END) AS dead_letter
    FROM processing_jobs`).first<Record<string, number>>();
  return {
    depth: Number(row?.depth ?? 0),
    retryWait: Number(row?.retry_wait ?? 0),
    deadLetter: Number(row?.dead_letter ?? 0),
  };
}

export async function runScheduledJob(bindings: ArchiveBindings, cron: string) {
  await assertSchemaReady(bindings.DB);
  if (cron === CONTENT_SCAN_CRON) {
    const deadline = Date.now() + 8 * 60_000;
    if (!bindings.CONTENT_SCAN_SERVICE_URL || !bindings.CONTENT_SCAN_SERVICE_TOKEN) {
      logEvent("error", "cron.content-scan-skipped", { reason: "content scan service configuration missing" });
    } else {
      await measured("cron.content-scan", { cron }, async () => {
        let processed = 0;
        while (processed < 3 && Date.now() < deadline) {
          const result = await processNextContentScanJob({
            db: bindings.DB,
            serviceUrl: bindings.CONTENT_SCAN_SERVICE_URL!,
            serviceToken: bindings.CONTENT_SCAN_SERVICE_TOKEN!,
          });
          if (!result.processed) break;
          processed += 1;
        }
        const metrics = await bindings.DB.prepare(`SELECT
          SUM(CASE WHEN status IN ('QUEUED', 'RETRY') THEN 1 ELSE 0 END) AS depth,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS dead_letter
          FROM content_scan_jobs`).first<Record<string, number>>();
        logEvent("info", "cron.content-scan-result", {
          processed,
          queueDepth: Number(metrics?.depth ?? 0),
          deadLetter: Number(metrics?.dead_letter ?? 0),
        });
      });
    }

    if (!bindings.QUARANTINE_FILES) {
      logEvent("error", "cron.promotion-skipped", { reason: "QUARANTINE_FILES binding missing" });
    } else {
      await measured("cron.promotion", { cron }, async () => {
        let processed = 0;
        const storages = getPromotionStorages(bindings);
        while (processed < 3 && Date.now() < deadline) {
          const result = await processNextPromotionJob({
            db: bindings.DB,
            ...storages,
            hasher: createDigestStreamHasher(),
          });
          if (!result.processed) break;
          processed += 1;
        }
        const metrics = await bindings.DB.prepare(`SELECT
          SUM(CASE WHEN status IN ('QUEUED', 'RETRY') THEN 1 ELSE 0 END) AS depth,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS dead_letter
          FROM promotion_jobs`).first<Record<string, number>>();
        logEvent("info", "cron.promotion-result", {
          processed,
          queueDepth: Number(metrics?.depth ?? 0),
          deadLetter: Number(metrics?.dead_letter ?? 0),
        });
      });
    }

    if (!bindings.DOCUMENT_RENDER_SERVICE_URL || !bindings.DOCUMENT_RENDER_SERVICE_TOKEN
      || !bindings.DOCUMENT_RENDER_IMAGE_DIGEST || !bindings.DERIVATIVE_FILES) {
      logEvent("warn", "cron.derivative-skipped", {
        reason: "document render service, image digest, or DERIVATIVE_FILES configuration missing",
      });
    } else {
      await measured("cron.derivative", { cron }, async () => {
        // Render pahalıdır: tetikleme başına tek iş; kalanlar sonraki dakikada sürer.
        let processed = 0;
        if (Date.now() < deadline) {
          const result = await processNextDerivativeJob({
            db: bindings.DB,
            derivativeReader: storageReader(bindings.DERIVATIVE_FILES!),
            hasher: createDigestStreamHasher(),
            serviceUrl: bindings.DOCUMENT_RENDER_SERVICE_URL!,
            serviceToken: bindings.DOCUMENT_RENDER_SERVICE_TOKEN!,
            expectedImageDigest: bindings.DOCUMENT_RENDER_IMAGE_DIGEST!,
          });
          if (result.processed) processed += 1;
        }
        const metrics = await bindings.DB.prepare(`SELECT
          SUM(CASE WHEN status IN ('QUEUED', 'RETRY', 'RENDERING') THEN 1 ELSE 0 END) AS depth,
          SUM(CASE WHEN status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END) AS review_required,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS dead_letter
          FROM derivative_jobs`).first<Record<string, number>>();
        logEvent("info", "cron.derivative-result", {
          processed,
          queueDepth: Number(metrics?.depth ?? 0),
          reviewRequired: Number(metrics?.review_required ?? 0),
          deadLetter: Number(metrics?.dead_letter ?? 0),
        });
      });
    }
    return;
  }
  if (cron === OCR_CRON) {
    if (!bindings.OCR_SERVICE_URL) {
      logEvent("error", "cron.ocr-skipped", { reason: "OCR_SERVICE_URL missing" });
      return;
    }
    await measured("cron.ocr", { cron }, async () => {
      const before = await readQueueMetrics(bindings.DB);
      const started = Date.now();
      let processed = 0;
      // Tek tetikleyici kuyruğu sınırlı bir dilimde tüketir. Üst sınırlar Worker
      // süresini korur; kalan işler sonraki Cron tetikleyicisinde devam eder.
      while (processed < 5 && Date.now() - started < 8 * 60_000) {
        const result = await processNextOcrJob(bindings, {
          actor: "system:cron",
          unit: "*",
          serviceUrl: bindings.OCR_SERVICE_URL!,
        });
        if (!result.processed) break;
        processed += 1;
      }
      const after = await readQueueMetrics(bindings.DB);
      logEvent("info", "cron.ocr-result", {
        processed,
        queueDepthBefore: before.depth,
        queueDepthAfter: after.depth,
        retryWait: after.retryWait,
        deadLetter: after.deadLetter,
      });
      /*
       * Dead-letter ARTIŞI alarm olayıdır: iş azami denemesini tüketti ve
       * artık kendi kendine düzelmeyecek. Mevcut birikinti her turda yeniden
       * bildirilmez — alarm sayaç deltasına bağlıdır, spam üretmez.
       */
      if (after.deadLetter > before.deadLetter) {
        await dispatchAlert(bindings, {
          severity: "critical",
          event: "ocr.dead-letter",
          title: `${after.deadLetter - before.deadLetter} OCR işi azami denemeyi tüketti; işletim incelemesi gerekiyor.`,
          detail: { deadLetter: after.deadLetter, queueDepth: after.depth },
        });
      }
    });
    return;
  }
  if (cron === MAINTENANCE_CRON) {
    await measured("cron.maintenance", { cron }, async () => {
      const result = await runMaintenanceSlice(bindings.DB, { batchSize: 200, maxBatches: 3 });
      let ingestLifecycle = { expired: 0, skipped: true };
      if (bindings.TEMPORARY_FILES && bindings.QUARANTINE_FILES) {
        const lifecycle = await expireIncompleteUploads({
          db: bindings.DB,
          temporary: storageStaging(bindings.TEMPORARY_FILES),
          quarantine: storageStaging(bindings.QUARANTINE_FILES),
          hasher: createDigestStreamHasher(),
        });
        ingestLifecycle = { ...lifecycle, skipped: false };
      }

      // F1.8: envanter bütün kalıcı ad alanlarını tarar; tüketici ise her kovanın
      // kendi dar reader/writer rolüyle çalışır. Böylece türev işleri açılıp sahipsiz kalmaz.
      const archiveReader = storageReader(bindings.ARCHIVE_FILES);
      const migrationTargets = [{
        namespace: "ARCHIVE_FILES",
        reader: archiveReader,
        writer: storageVaultWriter(bindings.ARCHIVE_FILES, archiveReader),
      }];
      if (bindings.DERIVATIVE_FILES) {
        const derivativeReader = storageReader(bindings.DERIVATIVE_FILES);
        migrationTargets.push({
          namespace: "DERIVATIVE_FILES",
          reader: derivativeReader,
          writer: storageVaultWriter(bindings.DERIVATIVE_FILES, derivativeReader),
        });
      }
      const readerForNamespace = (namespace: string) => {
        const target = migrationTargets.find((entry) => entry.namespace === namespace);
        if (!target) throw new Error(`Anahtar taşıma ad alanı yapılandırılmamış: ${namespace}`);
        return target.reader;
      };
      const baseMigrationDependencies = {
        db: bindings.DB,
        hasher: createDigestStreamHasher(),
        readerForNamespace,
      };
      const inventory = await runKeyInventorySlice({
        ...baseMigrationDependencies,
        ...migrationTargets[0],
      });
      let migrated = 0;
      // İki geçişli round-robin: bir ad alanı boşsa diğeri kalan dilimi kullanabilir.
      for (let pass = 0; pass < 2 && migrated < 2; pass += 1) {
        let progress = false;
        for (const target of migrationTargets) {
          if (migrated >= 2) break;
          const migration = await processNextKeyMigrationJob({
            ...baseMigrationDependencies,
            ...target,
          });
          if (migration.processed) {
            migrated += 1;
            progress = true;
          }
        }
        if (!progress) break;
      }
      // ADR-017: yedek dilimi bakım turuna bağlıdır; hızını backup_runs
      // defterinden alır (saatlik artımlı, günlük döküm + manifest, aylık
      // tutarlılık kontrolü).
      const backup = await runBackupSlice(bindings);
      // Kapasite kotası: eşik aşımı günde bir kez alarma bağlanır.
      const quota = await runQuotaCheck(bindings);

      logEvent("info", "cron.maintenance-result", {
        ...result,
        ingestLifecycle,
        keyInventory: { checked: inventory.checked, enqueued: inventory.enqueued, done: inventory.done },
        keyMigrationsProcessed: migrated,
        backup,
        quota,
      });
    });
    return;
  }
  if (cron === INTEGRITY_CRON) {
    await measured("cron.integrity", { cron }, async () => {
      const archiveReader = storageReader(bindings.ARCHIVE_FILES);
      const derivativeReader = bindings.DERIVATIVE_FILES
        ? storageReader(bindings.DERIVATIVE_FILES) : null;
      const readerForNamespace = (namespace: string) => {
        if (namespace === "ARCHIVE_FILES") return archiveReader;
        if (namespace === "DERIVATIVE_FILES" && derivativeReader) return derivativeReader;
        throw new Error(`Bütünlük okuma rolü yapılandırılmamış: ${namespace}`);
      };
      const integrity = await runIntegritySlice(
        bindings.DB, readerForNamespace, createDigestStreamHasher(),
      );
      const namespaces = [{
        name: "ARCHIVE_FILES",
        inventory: storageInventory(bindings.ARCHIVE_FILES),
        reader: archiveReader,
      }];
      if (bindings.DERIVATIVE_FILES && derivativeReader) {
        namespaces.push({
          name: "DERIVATIVE_FILES",
          inventory: storageInventory(bindings.DERIVATIVE_FILES),
          reader: derivativeReader,
        });
      }
      const reconciliation = await runReconciliationSlice({
        db: bindings.DB,
        inventory: namespaces[0].inventory,
        reader: archiveReader,
        namespaces,
      });
      logEvent("info", "cron.integrity-result", {
        integrity: {
          claimed: integrity.claimed,
          profile: "profile" in integrity ? integrity.profile : null,
          checked: integrity.checked,
          findings: integrity.findings,
          done: integrity.done,
        },
        reconciliation: {
          claimed: reconciliation.claimed,
          phase: "phase" in reconciliation ? reconciliation.phase : null,
          checked: reconciliation.checked,
          findings: reconciliation.findings,
          done: reconciliation.done,
        },
      });
      /*
       * Bütünlük/uzlaştırma bulgusu WORM kasada bozulma ya da kayıp demektir;
       * biri panoya bakana kadar bekleyemez. Alarm YENİ bulgu üreten dilimde
       * atılır (findings bu dilimin sayacıdır, kalıcı toplam değil).
       */
      if (integrity.findings > 0 || reconciliation.findings > 0) {
        await dispatchAlert(bindings, {
          severity: "critical",
          event: "integrity.finding",
          title: "Nesne bütünlük/uzlaştırma taraması yeni bulgu üretti; işletim incelemesi gerekiyor.",
          detail: {
            integrityFindings: integrity.findings,
            reconciliationFindings: reconciliation.findings,
          },
        });
      }
    });
    return;
  }
  logEvent("warn", "cron.unknown", { cron });
}
