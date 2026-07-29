import { processNextOcrJob } from "../app/api/jobs/process/route.ts";
import { assertSchemaReady, runMaintenanceSlice } from "./archive-schema.ts";
import type { ArchiveBindings } from "./archive-storage.ts";
import { createObjectStorage } from "./object-storage.ts";
import { runIntegritySlice } from "./integrity.ts";
import { logEvent, measured } from "./observability.ts";

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
    });
    return;
  }
  if (cron === MAINTENANCE_CRON) {
    await measured("cron.maintenance", { cron }, async () => {
      const result = await runMaintenanceSlice(bindings.DB, { batchSize: 200, maxBatches: 3 });
      logEvent("info", "cron.maintenance-result", result);
    });
    return;
  }
  if (cron === INTEGRITY_CRON) {
    await measured("cron.integrity", { cron }, async () => {
      await runIntegritySlice(bindings.DB, createObjectStorage(bindings.ARCHIVE_FILES));
    });
    return;
  }
  logEvent("warn", "cron.unknown", { cron });
}
