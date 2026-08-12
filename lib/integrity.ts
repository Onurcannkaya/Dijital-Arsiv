/**
 * F1.6 — Kalıcı ve çökme-kurtarılabilir bütünlük taraması.
 *
 * `quick` başlık/metadata kontrollerini, `full` akışlı SHA-256 doğrulamasını
 * yapar. Her koşu başında SQLite `rowid` üst su işareti alınır; koşu sürerken
 * gelen yeni belgeler bir sonraki koşuya kalır ve kanıt kapsamı değişmez.
 */

import type { ObjectReader } from "./object-storage.ts";
import type { StreamingHasher } from "./content-hasher.ts";
import {
  MaintenanceLeaseLostError,
  claimMaintenanceLease,
  failMaintenanceLease,
  renewMaintenanceLease,
  type MaintenanceLease,
} from "./maintenance-lease.ts";
import { logEvent } from "./observability.ts";

export const INTEGRITY_SCAN_TASK = "integrity-scan";
const LOCK_SECONDS = 15 * 60;
const FULL_PROFILE_SLICE_LIMIT = 5;

export type IntegrityProfile = "quick" | "full";

type IntegrityRun = {
  id: string;
  profile: IntegrityProfile;
  cursor: string | null;
  snapshot_max_rowid: number | null;
  checked_count: number;
  finding_count: number;
};

type BinaryObjectRow = {
  scan_rowid: number;
  id: string;
  object_key: string;
  byte_size: number;
  sha256: string;
  storage_version_id: string | null;
  bucket_or_namespace: string;
};

type ObjectReaderSource = ObjectReader | ((namespace: string) => ObjectReader);

function readerFor(source: ObjectReaderSource, namespace: string) {
  return typeof source === "function" ? source(namespace) : source;
}

type FindingInput = {
  binaryObjectId: string | null;
  objectKey: string;
  findingType: "MISSING" | "SIZE_MISMATCH" | "HASH_MISMATCH" | "UNREADABLE";
  expectedSha256: string | null;
  actualSha256: string | null;
  severity: "HIGH" | "CRITICAL";
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

/** Genel bakış: açık bulgular ve son tamamlanan koşular. */
export async function readIntegritySummary(db: D1Database) {
  const findings = await db.prepare(`SELECT
      SUM(CASE WHEN status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status <> 'RESOLVED' AND severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical
    FROM integrity_findings`).first<Record<string, number>>();
  const lastRuns = await db.prepare(`SELECT profile, status, checked_count, finding_count, started_at, completed_at
    FROM integrity_runs WHERE status = 'COMPLETED'
    ORDER BY completed_at DESC LIMIT 2`).all<{
      profile: IntegrityProfile; status: string; checked_count: number;
      finding_count: number; started_at: string; completed_at: string;
    }>();
  return {
    openFindings: Number(findings?.open ?? 0),
    criticalFindings: Number(findings?.critical ?? 0),
    lastCompletedRuns: lastRuns.results.map((run) => ({
      profile: run.profile,
      checked: Number(run.checked_count),
      findings: Number(run.finding_count),
      startedAt: run.started_at,
      completedAt: run.completed_at,
    })),
  };
}

async function ensureIntegrityTask(db: D1Database) {
  const total = await db.prepare(`SELECT COUNT(*) AS count FROM binary_objects
    WHERE retention_status <> 'DISPOSED'`).first<{ count: number }>();
  await db.prepare(`INSERT INTO maintenance_tasks (id, status, cursor, processed, total)
    VALUES (?, 'PENDING', NULL, 0, ?)
    ON CONFLICT(id) DO NOTHING`).bind(INTEGRITY_SCAN_TASK, Number(total?.count ?? 0)).run();
  await db.prepare(`UPDATE maintenance_tasks SET status = 'PENDING', cursor = NULL, processed = 0,
      total = ?, lease_token = NULL, locked_until = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'DONE' AND updated_at < datetime('now', '-1 day')`)
    .bind(Number(total?.count ?? 0), INTEGRITY_SCAN_TASK).run();
}

async function currentMaxRowid(db: D1Database, table: "binary_objects") {
  const row = await db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS value FROM ${table}`)
    .first<{ value: number }>();
  return Number(row?.value ?? 0);
}

async function setSnapshotTotal(db: D1Database, lease: MaintenanceLease, maxRowid: number) {
  const total = await db.prepare(`SELECT COUNT(*) AS count FROM binary_objects
    WHERE rowid <= ? AND retention_status <> 'DISPOSED'`).bind(maxRowid).first<{ count: number }>();
  const result = await db.prepare(`UPDATE maintenance_tasks SET total = ?
    WHERE id = ? AND status = 'RUNNING' AND lease_token = ?`)
    .bind(Number(total?.count ?? 0), lease.taskId, lease.token).run();
  if (!result.meta.changes) throw new MaintenanceLeaseLostError(lease.taskId);
}

/** Aktif koşuyu döndürür; eski v15 koşusunu deterministik su işaretine yükseltir. */
async function ensureActiveRun(db: D1Database, lease: MaintenanceLease): Promise<IntegrityRun> {
  const active = await db.prepare(`SELECT id, profile, cursor, snapshot_max_rowid, checked_count, finding_count
    FROM integrity_runs WHERE status = 'RUNNING' ORDER BY started_at LIMIT 1`).first<IntegrityRun>();
  const maxRowid = await currentMaxRowid(db, "binary_objects");
  if (active) {
    if (active.snapshot_max_rowid !== null) return active;
    const result = await db.prepare(`UPDATE integrity_runs
      SET cursor = NULL, snapshot_max_rowid = ?, checked_count = 0, finding_count = 0
      WHERE id = ? AND EXISTS (SELECT 1 FROM maintenance_tasks
        WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)`)
      .bind(maxRowid, active.id, lease.taskId, lease.token).run();
    if (!result.meta.changes) throw new MaintenanceLeaseLostError(lease.taskId);
    await setSnapshotTotal(db, lease, maxRowid);
    return { ...active, cursor: null, snapshot_max_rowid: maxRowid, checked_count: 0, finding_count: 0 };
  }
  const previous = await db.prepare(`SELECT profile FROM integrity_runs
    WHERE status = 'COMPLETED' ORDER BY completed_at DESC LIMIT 1`)
    .first<{ profile: IntegrityProfile }>();
  const profile: IntegrityProfile = previous?.profile === "quick" ? "full" : "quick";
  const id = crypto.randomUUID();
  const inserted = await db.prepare(`INSERT INTO integrity_runs
      (id, status, profile, cursor, snapshot_max_rowid, checked_count, finding_count)
    SELECT ?, 'RUNNING', ?, NULL, ?, 0, 0
    WHERE EXISTS (SELECT 1 FROM maintenance_tasks
      WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)`)
    .bind(id, profile, maxRowid, lease.taskId, lease.token).run();
  if (!inserted.meta.changes) throw new MaintenanceLeaseLostError(lease.taskId);
  await setSnapshotTotal(db, lease, maxRowid);
  return { id, profile, cursor: null, snapshot_max_rowid: maxRowid, checked_count: 0, finding_count: 0 };
}

/** Yeni bulgu kimliği aynı zamanda yapılandırılmış alarm korelasyon kimliğidir. */
async function recordFinding(
  db: D1Database,
  lease: MaintenanceLease,
  runId: string,
  finding: FindingInput,
): Promise<boolean> {
  const findingId = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO integrity_findings
      (id, run_id, binary_object_id, object_key, finding_type,
       expected_sha256, actual_sha256, severity, status)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN'
    WHERE EXISTS (SELECT 1 FROM maintenance_tasks
      WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)
      AND NOT EXISTS (SELECT 1 FROM integrity_findings
        WHERE object_key = ? AND finding_type = ? AND status <> 'RESOLVED')`)
    .bind(findingId, runId, finding.binaryObjectId, finding.objectKey,
      finding.findingType, finding.expectedSha256, finding.actualSha256, finding.severity,
      lease.taskId, lease.token, finding.objectKey, finding.findingType).run();
  const inserted = Boolean(result.meta.changes);
  if (inserted) {
    logEvent("error", "integrity.finding-created", {
      findingId,
      runId,
      objectId: finding.binaryObjectId,
      findingType: finding.findingType,
      severity: finding.severity,
    });
  }
  return inserted;
}

function isContentSha(value: string | null): value is string {
  return Boolean(value && /^[a-f0-9]{64}$/.test(value));
}

async function quickChecks(reader: Pick<ObjectReader, "head">, row: BinaryObjectRow): Promise<FindingInput | null> {
  const head = await reader.head(row.object_key);
  if (!head) {
    return {
      binaryObjectId: row.id, objectKey: row.object_key, findingType: "MISSING",
      expectedSha256: row.sha256, actualSha256: null, severity: "CRITICAL",
    };
  }
  if (head.size !== Number(row.byte_size)) {
    return {
      binaryObjectId: row.id, objectKey: row.object_key, findingType: "SIZE_MISMATCH",
      expectedSha256: row.sha256, actualSha256: null, severity: "HIGH",
    };
  }
  const metadataSha = head.customMetadata?.sha256?.toLowerCase() ?? null;
  if (isContentSha(metadataSha) && metadataSha !== row.sha256) {
    return {
      binaryObjectId: row.id, objectKey: row.object_key, findingType: "HASH_MISMATCH",
      expectedSha256: row.sha256, actualSha256: metadataSha, severity: "CRITICAL",
    };
  }
  const providerSha = head.providerChecksumSha256?.toLowerCase() ?? null;
  if (isContentSha(providerSha) && providerSha !== row.sha256) {
    return {
      binaryObjectId: row.id, objectKey: row.object_key, findingType: "HASH_MISMATCH",
      expectedSha256: row.sha256, actualSha256: providerSha, severity: "CRITICAL",
    };
  }
  if (row.storage_version_id && head.providerVersionId
    && row.storage_version_id !== head.providerVersionId) {
    logEvent("warn", "integrity.version-drift", { objectId: row.id });
  }
  return null;
}

async function fullChecks(
  reader: ObjectReader,
  hasher: StreamingHasher,
  row: BinaryObjectRow,
): Promise<FindingInput | null> {
  const quick = await quickChecks(reader, row);
  if (quick) return quick;
  // Sağlayıcı/akış hataları kalıcı bozulma kanıtı değildir. İşi FAILED yapıp
  // yeniden denetiriz; yalnız tutarlı şekilde yok/okunamaz yanıtı bulgu olur.
  const object = await reader.get(row.object_key);
  if (!object || object.range !== null) {
    return {
      binaryObjectId: row.id, objectKey: row.object_key, findingType: "UNREADABLE",
      expectedSha256: row.sha256, actualSha256: null, severity: "HIGH",
    };
  }
  const digest = await hasher.sha256(object.body);
  if (digest.byteSize !== Number(row.byte_size) || digest.sha256Hex !== row.sha256) {
    return {
      binaryObjectId: row.id, objectKey: row.object_key, findingType: "HASH_MISMATCH",
      expectedSha256: row.sha256, actualSha256: digest.sha256Hex, severity: "CRITICAL",
    };
  }
  return null;
}
/** Staging kabul probu ve dar s?zle?me testleri i?in ?retim tam-SHA karar?n? ?al??t?r?r. */
export async function evaluateFullIntegrityObject(
  reader: ObjectReader,
  hasher: StreamingHasher,
  input: {
    id: string;
    objectKey: string;
    byteSize: number;
    sha256: string;
    storageVersionId?: string | null;
    namespace?: string;
  },
) {
  return fullChecks(reader, hasher, {
    scan_rowid: 0,
    id: input.id,
    object_key: input.objectKey,
    byte_size: input.byteSize,
    sha256: input.sha256,
    storage_version_id: input.storageVersionId ?? null,
    bucket_or_namespace: input.namespace ?? "ARCHIVE_FILES",
  });
}

function fenced(results: D1Result<unknown>[], lease: MaintenanceLease) {
  if (!results.every((result) => Boolean(result.meta.changes))) {
    throw new MaintenanceLeaseLostError(lease.taskId);
  }
}

export async function runIntegritySlice(
  db: D1Database,
  readerSource: ObjectReaderSource,
  hasher: StreamingHasher,
  batchSize = 20,
) {
  await ensureIntegrityTask(db);
  const lease = await claimMaintenanceLease(db, INTEGRITY_SCAN_TASK, LOCK_SECONDS);
  if (!lease) return { claimed: false, checked: 0, findings: 0, done: false };

  try {
    const run = await ensureActiveRun(db, lease);
    const snapshotMaxRowid = Number(run.snapshot_max_rowid ?? 0);
    const cursor = run.cursor === null ? 0 : Number(run.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Bütünlük koşusu imleci geçersiz.");
    const limit = run.profile === "full"
      ? Math.min(Math.max(Math.trunc(batchSize), 1), FULL_PROFILE_SLICE_LIMIT)
      : Math.min(Math.max(Math.trunc(batchSize), 1), 100);
    const rows = await db.prepare(`SELECT rowid AS scan_rowid, id, object_key, byte_size, sha256,
        storage_version_id, bucket_or_namespace
      FROM binary_objects
      WHERE rowid > ? AND rowid <= ? AND retention_status <> 'DISPOSED'
        AND object_class IN ('original', 'access', 'ocr', 'preservation', 'thumbnail')
      ORDER BY rowid LIMIT ?`).bind(cursor, snapshotMaxRowid, limit).all<BinaryObjectRow>();

    if (!rows.results.length) {
      const results = await db.batch([
        db.prepare(`UPDATE integrity_runs SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND EXISTS (SELECT 1 FROM maintenance_tasks
            WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)`)
          .bind(run.id, lease.taskId, lease.token),
        db.prepare(`UPDATE maintenance_tasks SET status = 'DONE', lease_token = NULL,
          locked_until = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'RUNNING' AND lease_token = ?`)
          .bind(lease.taskId, lease.token),
      ]);
      fenced(results, lease);
      logEvent("info", "integrity.run-completed", {
        runId: run.id, profile: run.profile,
        checked: Number(run.checked_count), findings: Number(run.finding_count),
        snapshotMaxRowid,
      });
      return { claimed: true, runId: run.id, profile: run.profile, checked: 0, findings: 0, done: true };
    }

    let findings = 0;
    for (const row of rows.results) {
      await renewMaintenanceLease(db, lease, LOCK_SECONDS);
      const reader = readerFor(readerSource, row.bucket_or_namespace);
      const finding = run.profile === "full"
        ? await fullChecks(reader, hasher, row)
        : await quickChecks(reader, row);
      if (finding) {
        await recordFinding(db, lease, run.id, finding);
        // Koşu özeti yeni alarmı değil, bu koşuda gözlenen ihlali sayar.
        findings += 1;
      }
    }

    const nextCursor = Number(rows.results[rows.results.length - 1].scan_rowid);
    const checked = Number(run.checked_count) + rows.results.length;
    const results = await db.batch([
      db.prepare(`UPDATE integrity_runs SET cursor = ?, checked_count = ?, finding_count = finding_count + ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM maintenance_tasks
          WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)`)
        .bind(String(nextCursor), checked, findings, run.id, lease.taskId, lease.token),
      db.prepare(`UPDATE maintenance_tasks SET status = 'PENDING', cursor = ?, processed = ?,
        lease_token = NULL, locked_until = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'RUNNING' AND lease_token = ?`)
        .bind(String(nextCursor), checked, lease.taskId, lease.token),
    ]);
    fenced(results, lease);
    logEvent(findings ? "warn" : "info", "integrity.slice-completed", {
      runId: run.id, profile: run.profile, checked: rows.results.length,
      findings, totalChecked: checked,
    });
    return { claimed: true, runId: run.id, profile: run.profile, checked: rows.results.length, findings, done: false };
  } catch (error) {
    await failMaintenanceLease(db, lease, error);
    throw error;
  }
}
