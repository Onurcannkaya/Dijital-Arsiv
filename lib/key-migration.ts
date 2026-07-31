/**
 * F1.8 — Eski nesne anahtarlarının yetkili taşınması.
 *
 * İki aşama vardır:
 *
 * 1. **Envanter dilimi:** `binary_objects` rowid su işaretiyle sayfalanır, her
 *    anahtar `classifyObjectKey` ile sınıflandırılır ve eski biçimli her nesne
 *    için maskeli envanter + taşıma işi satırı açılır. Ham anahtar yalnız iş
 *    satırında durur; log ve denetim kanıtı maskeli biçimi kullanır.
 * 2. **Taşıma işi:** kaynak nesne if-absent koşuluyla güvenli hedef anahtara
 *    kopyalanır (F1.1 `promote` yeteneği), hedef akışla tam okunup SHA-256
 *    yetkili kayıtla doğrulanır ve `binary_objects.object_key` referansı tek
 *    kira-çitli batch'te atomik değiştirilir. Eski nesne SİLİNMEZ: okuma yolu
 *    yeni anahtara döndüğü için erişime kapanır ve tasfiyesi ayrı yetkili
 *    prosedüre kalır (ADR-016). `archive_documents.storage_key` kabul makbuzu
 *    olarak dokunulmadan bırakılır; çift yazma yeniden kurulmaz.
 */

import { prepareAuditEvent } from "./audit.ts";
import {
  classifyMetadataFields,
  classifyObjectKey,
  secureTargetKey,
} from "./key-classification.ts";
import {
  MaintenanceLeaseLostError,
  claimMaintenanceLease,
  failMaintenanceLease,
  type MaintenanceLease,
} from "./maintenance-lease.ts";
import {
  isObjectStorageError,
  type ImmutableVaultWriter,
  type ObjectReader,
} from "./object-storage.ts";
import type { StreamingHasher } from "./content-hasher.ts";
import { logEvent } from "./observability.ts";

export const KEY_INVENTORY_TASK = "legacy-key-inventory";
export const KEY_MIGRATION_LEASE_MS = 30 * 60 * 1000;
const INVENTORY_LOCK_SECONDS = 120;

type MigrationJob = {
  id: string;
  binary_object_id: string;
  document_id: string;
  object_class: string;
  source_object_key: string;
  target_object_key: string;
  masked_key_pattern: string;
  source_sha256: string;
  attempt: number;
  max_attempts: number;
  lease_token: string;
};

type SourceRecord = {
  object_key: string;
  media_type: string;
  byte_size: number;
  sha256: string;
};

export type KeyMigrationDependencies = {
  db: D1Database;
  /** Taşınan ad alanının okuyucusu; kaynak ve hedef aynı ad alanındadır. */
  reader: ObjectReader;
  /** Koşullu ilk yazma + promote yeteneği (F1.1); silme yeteneği yoktur. */
  writer: ImmutableVaultWriter;
  hasher: StreamingHasher;
  /** Bu bağların hizmet ettiği ad alanı; diğer ad alanlarının işleri alınmaz. */
  namespace?: string;
  now?: () => Date;
  randomId?: () => string;
};

function clock(dependencies: KeyMigrationDependencies) {
  return dependencies.now?.() ?? new Date();
}

function randomId(dependencies: KeyMigrationDependencies) {
  return dependencies.randomId?.() ?? crypto.randomUUID();
}

function namespaceOf(dependencies: KeyMigrationDependencies) {
  return dependencies.namespace ?? "ARCHIVE_FILES";
}

/**
 * Envanter dilimi: rowid su işaretine kadar olan kayıtları sınıflandırır ve
 * eski anahtarlar için maskeli iş satırı açar. Günlük yeniden koşu, sonradan
 * eklenen kayıtları da tarar; politika uyumlu anahtarlar iş üretmez.
 */
export async function runKeyInventorySlice(
  dependencies: KeyMigrationDependencies,
  batchSize = 100,
) {
  const db = dependencies.db;
  await db.prepare(`INSERT INTO maintenance_tasks (id, status, cursor, processed, total)
    VALUES (?, 'PENDING', NULL, 0, NULL)
    ON CONFLICT(id) DO NOTHING`).bind(KEY_INVENTORY_TASK).run();
  await db.prepare(`UPDATE maintenance_tasks SET status = 'PENDING', cursor = NULL, processed = 0,
      lease_token = NULL, locked_until = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'DONE' AND updated_at < datetime('now', '-1 day')`)
    .bind(KEY_INVENTORY_TASK).run();
  const lease = await claimMaintenanceLease(db, KEY_INVENTORY_TASK, INVENTORY_LOCK_SECONDS);
  if (!lease) return { claimed: false, checked: 0, enqueued: 0, done: false };

  try {
    const task = await db.prepare("SELECT cursor FROM maintenance_tasks WHERE id = ?")
      .bind(KEY_INVENTORY_TASK).first<{ cursor: string | null }>();
    const cursor = task?.cursor === null || task?.cursor === undefined ? 0 : Number(task.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Envanter imleci geçersiz.");
    const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 500);
    const rows = await db.prepare(`SELECT rowid AS scan_rowid, id, document_id, object_class,
        object_key, bucket_or_namespace, sha256
      FROM binary_objects
      WHERE rowid > ? AND retention_status <> 'DISPOSED'
        AND object_class IN ('original', 'access', 'ocr', 'preservation', 'thumbnail')
      ORDER BY rowid LIMIT ?`).bind(cursor, limit)
      .all<{ scan_rowid: number; id: string; document_id: string; object_class: string;
        object_key: string; bucket_or_namespace: string; sha256: string }>();

    let enqueued = 0;
    for (const row of rows.results) {
      const classification = classifyObjectKey(row.object_key, row.object_class);
      if (!classification.legacy) continue;
      // Hedef anahtar deterministiktir: yeniden koşu aynı hedefi üretir.
      const target = secureTargetKey(row.object_class, row.document_id, row.id);
      if (target === row.object_key) continue;
      const nowIso = clock(dependencies).toISOString();
      const inserted = await db.prepare(`INSERT OR IGNORE INTO legacy_key_migrations
          (id, binary_object_id, document_id, object_class, bucket_or_namespace,
           source_object_key, target_object_key, masked_key_pattern, classification_json,
           source_sha256, status, attempt, max_attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, 5, ?, ?)`)
        .bind(randomId(dependencies), row.id, row.document_id, row.object_class,
          row.bucket_or_namespace, row.object_key, target, classification.maskedPattern,
          JSON.stringify({ indicators: classification.indicators }), row.sha256, nowIso, nowIso).run();
      if (inserted.meta.changes) {
        enqueued += 1;
        logEvent("warn", "key-migration.legacy-key-found", {
          binaryObjectId: row.id,
          objectClass: row.object_class,
          maskedPattern: classification.maskedPattern,
          indicators: classification.indicators,
        });
      }
    }

    const done = rows.results.length < limit;
    const nextCursor = rows.results.length
      ? String(rows.results[rows.results.length - 1].scan_rowid)
      : task?.cursor ?? "0";
    const update = await db.prepare(`UPDATE maintenance_tasks SET status = ?, cursor = ?,
        processed = processed + ?, lease_token = NULL, locked_until = NULL,
        last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'RUNNING' AND lease_token = ?`)
      .bind(done ? "DONE" : "PENDING", nextCursor, rows.results.length,
        KEY_INVENTORY_TASK, lease.token).run();
    if (!update.meta.changes) throw new MaintenanceLeaseLostError(KEY_INVENTORY_TASK);
    return { claimed: true, checked: rows.results.length, enqueued, done };
  } catch (error) {
    await failMaintenanceLease(db, lease, error);
    throw error;
  }
}

async function claimJob(dependencies: KeyMigrationDependencies) {
  const now = clock(dependencies);
  const nowIso = now.toISOString();
  const leaseToken = randomId(dependencies);
  const leaseUntil = new Date(now.getTime() + KEY_MIGRATION_LEASE_MS).toISOString();
  return dependencies.db.prepare(`UPDATE legacy_key_migrations SET
      status = 'COPYING', attempt = attempt + 1, lease_token = ?,
      lease_expires_at = ?, last_error = NULL, updated_at = ?
    WHERE id = (
      SELECT j.id FROM legacy_key_migrations j
      WHERE j.bucket_or_namespace = ? AND j.attempt < j.max_attempts
        AND (
          (j.status IN ('QUEUED', 'RETRY') AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?))
          OR (j.status = 'COPYING' AND j.lease_expires_at <= ?)
        )
      ORDER BY j.created_at LIMIT 1
    )
    RETURNING id, binary_object_id, document_id, object_class, source_object_key,
      target_object_key, masked_key_pattern, source_sha256, attempt, max_attempts, lease_token`)
    .bind(leaseToken, leaseUntil, nowIso, namespaceOf(dependencies), nowIso, nowIso)
    .first<MigrationJob>();
}

async function renewLease(dependencies: KeyMigrationDependencies, job: MigrationJob) {
  const now = clock(dependencies);
  const result = await dependencies.db.prepare(`UPDATE legacy_key_migrations
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'COPYING' AND lease_token = ?`)
    .bind(new Date(now.getTime() + KEY_MIGRATION_LEASE_MS).toISOString(),
      now.toISOString(), job.id, job.lease_token).run();
  if (!result.meta.changes) throw new Error("Anahtar taşıma kirası kaybedildi.");
}

async function recordFailure(
  dependencies: KeyMigrationDependencies,
  job: MigrationJob,
  error: unknown,
): Promise<"RETRY" | "FAILED" | "STALE"> {
  const now = clock(dependencies);
  const terminal = job.attempt >= job.max_attempts;
  const delay = Math.min(3600, 30 * (2 ** Math.max(0, job.attempt - 1)));
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const update = await dependencies.db.prepare(`UPDATE legacy_key_migrations SET status = ?,
      next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
      failure_code = 'MIGRATION_FAILED', last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'COPYING' AND lease_token = ?`)
    .bind(terminal ? "FAILED" : "RETRY",
      terminal ? null : new Date(now.getTime() + delay * 1000).toISOString(),
      message, now.toISOString(), job.id, job.lease_token).run();
  if (!update.meta.changes) return "STALE";
  logEvent("error", "key-migration.failed", {
    migrationId: job.id,
    binaryObjectId: job.binary_object_id,
    maskedPattern: job.masked_key_pattern,
    attempt: job.attempt,
    terminal,
  });
  return terminal ? "FAILED" : "RETRY";
}

/** Referans değişimi + denetim + iş kapanışı tek kira-çitli batch'te yazılır. */
async function finalizeSwap(
  dependencies: KeyMigrationDependencies,
  job: MigrationJob,
  metadataFindings: string[],
  targetSha256: string,
  swapAlreadyDone: boolean,
) {
  const nowIso = clock(dependencies).toISOString();
  const audit = await prepareAuditEvent(dependencies.db, {
    documentId: job.document_id,
    actor: "system:key-migration",
    action: "document.key-migrated",
    // Ham anahtar denetim kanıtına yazılmaz (yol haritası F1.8): maskeli biçim yeterlidir.
    details: {
      migrationId: job.id,
      binaryObjectId: job.binary_object_id,
      objectClass: job.object_class,
      maskedSourcePattern: job.masked_key_pattern,
      sha256: targetSha256,
      metadataFindingCount: metadataFindings.length,
    },
  });
  const statements = [
    dependencies.db.prepare(`UPDATE binary_objects SET object_key = ?
      WHERE id = ? AND object_key = ?
        AND EXISTS (SELECT 1 FROM legacy_key_migrations
          WHERE id = ? AND status = 'COPYING' AND lease_token = ?)`)
      .bind(job.target_object_key, job.binary_object_id, job.source_object_key,
        job.id, job.lease_token),
    audit.statement,
    dependencies.db.prepare(`UPDATE legacy_key_migrations SET status = 'COMPLETED',
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
      failure_code = NULL, last_error = NULL, metadata_findings_json = ?,
      target_sha256 = ?, verified_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'COPYING' AND lease_token = ?`)
      .bind(JSON.stringify(metadataFindings), targetSha256, nowIso, nowIso, nowIso,
        job.id, job.lease_token),
  ];
  // Önceki deneme referansı değiştirdiyse ilk ifade 0 satır etkiler; bu meşrudur.
  const results = await dependencies.db.batch(swapAlreadyDone ? statements.slice(1) : statements);
  if (!results.every((entry) => Boolean(entry.meta.changes))) {
    throw new Error("Anahtar taşıma sonlandırması kira çitine takıldı.");
  }
  logEvent("info", "key-migration.completed", {
    migrationId: job.id,
    binaryObjectId: job.binary_object_id,
    objectClass: job.object_class,
    maskedPattern: job.masked_key_pattern,
  });
  return { processed: true, result: "COMPLETED" as const, migrationId: job.id };
}

export async function readKeyMigrationSummary(db: D1Database) {
  const jobs = await db.prepare(`SELECT
      SUM(CASE WHEN status IN ('QUEUED', 'RETRY', 'COPYING') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS dead_letter
    FROM legacy_key_migrations`).first<Record<string, number>>();
  const inventory = await db.prepare(`SELECT status, processed, updated_at
    FROM maintenance_tasks WHERE id = ?`).bind(KEY_INVENTORY_TASK)
    .first<{ status: string; processed: number; updated_at: string }>();
  return {
    pending: Number(jobs?.pending ?? 0),
    completed: Number(jobs?.completed ?? 0),
    deadLetter: Number(jobs?.dead_letter ?? 0),
    inventory: inventory ? {
      status: inventory.status,
      scanned: Number(inventory.processed),
      updatedAt: inventory.updated_at,
    } : null,
  };
}

export async function processNextKeyMigrationJob(dependencies: KeyMigrationDependencies) {
  const job = await claimJob(dependencies);
  if (!job) return { processed: false };

  try {
    const record = await dependencies.db.prepare(`SELECT object_key, media_type, byte_size, sha256
      FROM binary_objects WHERE id = ?`).bind(job.binary_object_id).first<SourceRecord>();
    if (!record || record.sha256 !== job.source_sha256) {
      throw new Error("Taşıma işinin yetkili nesne kaydı bulunamadı veya SHA kanıtı değişti.");
    }
    // Önceki deneme referansı değiştirmiş olabilir: iş kapanışı kurtarılır.
    const swapAlreadyDone = record.object_key === job.target_object_key;
    if (!swapAlreadyDone && record.object_key !== job.source_object_key) {
      throw new Error("Nesne kaydı beklenmeyen bir anahtarı gösteriyor; el ile inceleme gerekir.");
    }

    // Metadata bulguları: yalnız alan adları sınıflandırılır, değer okunmaz/loglanmaz.
    const sourceHead = await dependencies.reader.head(job.source_object_key);
    const metadataFindings = classifyMetadataFields(sourceHead?.customMetadata);

    let targetExists = Boolean(await dependencies.reader.head(job.target_object_key));
    if (!targetExists) {
      if (!sourceHead) throw new Error("Taşıma kaynağı depolamada bulunamadı.");
      await renewLease(dependencies, job);
      try {
        await dependencies.writer.promote(job.source_object_key, job.target_object_key, {
          contentType: record.media_type,
          contentSha256Hex: job.source_sha256,
          // Eski metadata taşınmaz; hedef yalnız sözleşmedeki temiz alanları taşır.
          customMetadata: {
            sha256: job.source_sha256,
            documentId: job.document_id,
            binaryObjectId: job.binary_object_id,
            objectClass: job.object_class,
          },
        });
      } catch (error) {
        // Yanıt kaybı kurtarması: hedef bir önceki denemede yazılmış olabilir;
        // içerik birazdan tam okumayla kanıtlanacak.
        if (!isObjectStorageError(error, "KEY_ALREADY_EXISTS")) throw error;
      }
      targetExists = true;
    }

    await renewLease(dependencies, job);
    const target = await dependencies.reader.get(job.target_object_key);
    if (!target || target.range !== null) throw new Error("Taşıma hedefi tam okunamadı.");
    const digest = await dependencies.hasher.sha256(target.body);
    if (digest.byteSize !== Number(record.byte_size) || digest.sha256Hex !== job.source_sha256) {
      throw new Error("Taşıma hedefinin tam SHA-256 doğrulaması başarısız.");
    }

    return await finalizeSwap(dependencies, job, metadataFindings, digest.sha256Hex, swapAlreadyDone);
  } catch (error) {
    const status = await recordFailure(dependencies, job, error);
    return { processed: true, result: status };
  }
}
