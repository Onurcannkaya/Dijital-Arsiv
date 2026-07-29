import type { ObjectStorage } from "./object-storage.ts";
import { logEvent } from "./observability.ts";

export const INTEGRITY_SCAN_TASK = "integrity-scan";
const LOCK_SECONDS = 120;

type IntegrityTask = {
  id: string;
  cursor: string | null;
  processed: number;
  total: number | null;
};

type BinaryObjectRow = {
  id: string;
  object_key: string;
  byte_size: number;
  sha256: string;
};

export async function readIntegrityProgress(db: D1Database) {
  const row = await db.prepare(`SELECT status, processed, total, last_error, updated_at
    FROM maintenance_tasks WHERE id = ?`).bind(INTEGRITY_SCAN_TASK).first<{
      status: string; processed: number; total: number | null; last_error: string | null; updated_at: string;
    }>();
  return row ? {
    status: row.status,
    processed: Number(row.processed),
    total: row.total === null ? null : Number(row.total),
    lastError: row.last_error
      ? row.status === "FAILED" ? "Bütünlük taraması tamamlanamadı." : row.last_error
      : null,
    updatedAt: row.updated_at,
  } : null;
}

async function ensureIntegrityTask(db: D1Database) {
  const total = await db.prepare(`SELECT COUNT(*) AS count FROM binary_objects
    WHERE retention_status <> 'DISPOSED'`).first<{ count: number }>();
  await db.prepare(`INSERT INTO maintenance_tasks (id, status, cursor, processed, total)
    VALUES (?, 'PENDING', NULL, 0, ?)
    ON CONFLICT(id) DO NOTHING`).bind(INTEGRITY_SCAN_TASK, Number(total?.count ?? 0)).run();
  // Tamamlanmış tarama günde bir kez yeniden başlatılabilir.
  await db.prepare(`UPDATE maintenance_tasks SET status = 'PENDING', cursor = NULL, processed = 0,
      total = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'DONE' AND updated_at < datetime('now', '-1 day')`)
    .bind(Number(total?.count ?? 0), INTEGRITY_SCAN_TASK).run();
}

/**
 * Bütünlük taramasının sınırlı bir dilimini çalıştırır.
 *
 * Faz 0 iskeleti nesnenin varlığını, boyutunu ve kabul sırasında yazılan SHA-256
 * metadatasını denetler. Baytların yeniden okunup özetlenmesi daha pahalı tam
 * tarama profilinde ayrıca çalıştırılacaktır.
 */
export async function runIntegritySlice(db: D1Database, storage: ObjectStorage, batchSize = 20) {
  const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 100);
  await ensureIntegrityTask(db);
  const task = await db.prepare(`UPDATE maintenance_tasks
    SET status = 'RUNNING', locked_until = datetime('now', '+${LOCK_SECONDS} seconds'), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('PENDING', 'FAILED')
      AND (locked_until IS NULL OR locked_until < datetime('now'))
    RETURNING id, cursor, processed, total`).bind(INTEGRITY_SCAN_TASK).first<IntegrityTask>();
  if (!task) return { claimed: false, checked: 0, issues: 0, done: false };

  try {
    const rows = await db.prepare(`SELECT id, object_key, byte_size, sha256 FROM binary_objects
      WHERE retention_status <> 'DISPOSED' AND (? IS NULL OR id > ?)
      ORDER BY id LIMIT ?`).bind(task.cursor, task.cursor, limit).all<BinaryObjectRow>();
    if (!rows.results.length) {
      await db.prepare(`UPDATE maintenance_tasks SET status = 'DONE', locked_until = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(INTEGRITY_SCAN_TASK).run();
      return { claimed: true, checked: 0, issues: 0, done: true };
    }

    let issues = 0;
    for (const row of rows.results) {
      const head = await storage.head(row.object_key);
      const storedSha256 = head?.customMetadata?.sha256;
      const problem = !head
        ? "missing"
        : head.size !== Number(row.byte_size)
          ? "size-mismatch"
          : !storedSha256
            ? "sha256-metadata-missing"
            : storedSha256 !== row.sha256
              ? "sha256-metadata-mismatch"
              : null;
      if (problem) {
        issues += 1;
        logEvent("error", "integrity.object-mismatch", { objectId: row.id, problem });
      }
    }

    const cursor = rows.results[rows.results.length - 1].id;
    const processed = Number(task.processed) + rows.results.length;
    const done = rows.results.length < limit;
    await db.prepare(`UPDATE maintenance_tasks SET status = ?, cursor = ?, processed = ?,
        locked_until = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(done ? "DONE" : "PENDING", cursor, processed,
        issues ? `${issues} nesnede bütünlük sorunu bulundu` : null, INTEGRITY_SCAN_TASK).run();
    logEvent(issues ? "warn" : "info", "integrity.slice-completed", {
      checked: rows.results.length,
      issues,
      processed,
      total: task.total,
      done,
    });
    return { claimed: true, checked: rows.results.length, issues, done };
  } catch (error) {
    await db.prepare(`UPDATE maintenance_tasks SET status = 'FAILED', locked_until = NULL,
      last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(String(error instanceof Error ? error.message : error).slice(0, 500), INTEGRITY_SCAN_TASK).run();
    throw error;
  }
}
