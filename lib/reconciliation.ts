/**
 * F1.6 — Depo–veritabanı uzlaştırması.
 *
 * Üç yönü birlikte kanıtlar: depo nesnesi → yetkili `binary_objects` kaydı,
 * yetkili kayıt → depo nesnesi ve belge alındısı → asıl nesne kaydı. Koşu
 * sayfalı, anlık görüntü su işaretli ve kiralıdır; hiçbir şeyi otomatik silmez.
 */

import type { ObjectReader, StorageInventory } from "./object-storage.ts";
import {
  MaintenanceLeaseLostError,
  claimMaintenanceLease,
  failMaintenanceLease,
  renewMaintenanceLease,
  type MaintenanceLease,
} from "./maintenance-lease.ts";
import { logEvent } from "./observability.ts";

export const RECONCILIATION_TASK = "reconciliation-scan";
const LOCK_SECONDS = 15 * 60;
export const RECONCILIATION_MIN_AGE_MINUTES = 60;

type RunCursor =
  | { phase: "STORAGE"; namespaceIndex: number; cursor: string | null }
  | { phase: "DATABASE"; cursor: number | null }
  | { phase: "DOCUMENTS"; cursor: number | null };

type ReconciliationRun = {
  id: string;
  cursor: string | null;
  binary_snapshot_max_rowid: number | null;
  document_snapshot_max_rowid: number | null;
  checked_count: number;
  finding_count: number;
};

type FindingInput = {
  recordKind: "BINARY_OBJECT" | "ARCHIVE_DOCUMENT" | "STORAGE_OBJECT";
  recordId: string | null;
  objectKey: string;
  findingType: "ORPHAN_OBJECT" | "MISSING_OBJECT" | "MISSING_RECORD";
  severity: "HIGH" | "CRITICAL";
};

export type ReconciliationNamespace = {
  name: string;
  inventory: StorageInventory;
  reader: Pick<ObjectReader, "head">;
};

export type ReconciliationDependencies = {
  db: D1Database;
  /** Tek namespace kullanan eski çağrılar için geriye dönük alanlar. */
  inventory: StorageInventory;
  reader: Pick<ObjectReader, "head">;
  namespaces?: ReconciliationNamespace[];
  now?: () => Date;
};

function storageNamespaces(dependencies: ReconciliationDependencies): ReconciliationNamespace[] {
  return dependencies.namespaces?.length
    ? dependencies.namespaces
    : [{ name: "ARCHIVE_FILES", inventory: dependencies.inventory, reader: dependencies.reader }];
}

function clock(dependencies: ReconciliationDependencies) {
  return dependencies.now?.() ?? new Date();
}

function parseCursor(raw: string | null): RunCursor {
  if (!raw) return { phase: "STORAGE", namespaceIndex: 0, cursor: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.phase === "STORAGE" && (parsed.cursor === null || typeof parsed.cursor === "string")) {
      const namespaceIndex = typeof parsed.namespaceIndex === "number" && Number.isSafeInteger(parsed.namespaceIndex)
        ? Math.max(parsed.namespaceIndex, 0) : 0;
      return { phase: "STORAGE", namespaceIndex, cursor: parsed.cursor };
    }
    if ((parsed.phase === "DATABASE" || parsed.phase === "DOCUMENTS")
      && (parsed.cursor === null || (typeof parsed.cursor === "number" && Number.isSafeInteger(parsed.cursor)))) {
      return { phase: parsed.phase, cursor: parsed.cursor };
    }
  } catch { /* v15/bozuk imleç güvenli biçimde baştan alınır */ }
  return { phase: "STORAGE", namespaceIndex: 0, cursor: null };
}

export async function readReconciliationSummary(db: D1Database) {
  const findings = await db.prepare(`SELECT
      SUM(CASE WHEN status <> 'RESOLVED' AND finding_type = 'ORPHAN_OBJECT' THEN 1 ELSE 0 END) AS orphans,
      SUM(CASE WHEN status <> 'RESOLVED' AND finding_type = 'MISSING_OBJECT' THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN status <> 'RESOLVED' AND finding_type = 'MISSING_RECORD' THEN 1 ELSE 0 END) AS missing_records,
      SUM(CASE WHEN status <> 'RESOLVED' THEN 1 ELSE 0 END) AS open
    FROM reconciliation_findings`).first<Record<string, number>>();
  const lastRun = await db.prepare(`SELECT status, checked_count, finding_count, started_at, completed_at
    FROM reconciliation_runs WHERE status = 'COMPLETED'
    ORDER BY completed_at DESC LIMIT 1`).first<{
      status: string; checked_count: number; finding_count: number;
      started_at: string; completed_at: string;
    }>();
  return {
    openFindings: Number(findings?.open ?? 0),
    orphanObjects: Number(findings?.orphans ?? 0),
    missingObjects: Number(findings?.missing ?? 0),
    missingRecords: Number(findings?.missing_records ?? 0),
    lastCompletedRun: lastRun ? {
      checked: Number(lastRun.checked_count),
      findings: Number(lastRun.finding_count),
      startedAt: lastRun.started_at,
      completedAt: lastRun.completed_at,
    } : null,
  };
}

async function ensureTask(db: D1Database) {
  await db.prepare(`INSERT INTO maintenance_tasks (id, status, cursor, processed, total)
    VALUES (?, 'PENDING', NULL, 0, NULL)
    ON CONFLICT(id) DO NOTHING`).bind(RECONCILIATION_TASK).run();
  await db.prepare(`UPDATE maintenance_tasks SET status = 'PENDING', cursor = NULL, processed = 0,
      lease_token = NULL, locked_until = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'DONE' AND updated_at < datetime('now', '-1 day')`)
    .bind(RECONCILIATION_TASK).run();
}

async function maxRowid(db: D1Database, table: "binary_objects" | "archive_documents") {
  const row = await db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS value FROM ${table}`)
    .first<{ value: number }>();
  return Number(row?.value ?? 0);
}

async function ensureActiveRun(db: D1Database, lease: MaintenanceLease): Promise<ReconciliationRun> {
  const active = await db.prepare(`SELECT id, cursor, binary_snapshot_max_rowid,
      document_snapshot_max_rowid, checked_count, finding_count
    FROM reconciliation_runs WHERE status = 'RUNNING' ORDER BY started_at LIMIT 1`)
    .first<ReconciliationRun>();
  const binaryMax = await maxRowid(db, "binary_objects");
  const documentMax = await maxRowid(db, "archive_documents");
  if (active) {
    if (active.binary_snapshot_max_rowid !== null && active.document_snapshot_max_rowid !== null) return active;
    const result = await db.prepare(`UPDATE reconciliation_runs SET cursor = NULL,
        binary_snapshot_max_rowid = ?, document_snapshot_max_rowid = ?,
        checked_count = 0, finding_count = 0
      WHERE id = ? AND EXISTS (SELECT 1 FROM maintenance_tasks
        WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)`)
      .bind(binaryMax, documentMax, active.id, lease.taskId, lease.token).run();
    if (!result.meta.changes) throw new MaintenanceLeaseLostError(lease.taskId);
    return {
      ...active, cursor: null, binary_snapshot_max_rowid: binaryMax,
      document_snapshot_max_rowid: documentMax, checked_count: 0, finding_count: 0,
    };
  }
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO reconciliation_runs
      (id, status, cursor, binary_snapshot_max_rowid, document_snapshot_max_rowid,
       checked_count, finding_count)
    SELECT ?, 'RUNNING', NULL, ?, ?, 0, 0
    WHERE EXISTS (SELECT 1 FROM maintenance_tasks
      WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)`)
    .bind(id, binaryMax, documentMax, lease.taskId, lease.token).run();
  if (!result.meta.changes) throw new MaintenanceLeaseLostError(lease.taskId);
  return {
    id, cursor: null, binary_snapshot_max_rowid: binaryMax,
    document_snapshot_max_rowid: documentMax, checked_count: 0, finding_count: 0,
  };
}

async function recordFinding(
  db: D1Database,
  lease: MaintenanceLease,
  runId: string,
  finding: FindingInput,
): Promise<boolean> {
  const findingId = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO reconciliation_findings
      (id, run_id, record_kind, record_id, object_key, finding_type, severity, status)
    SELECT ?, ?, ?, ?, ?, ?, ?, 'OPEN'
    WHERE EXISTS (SELECT 1 FROM maintenance_tasks
      WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)
      AND NOT EXISTS (SELECT 1 FROM reconciliation_findings
        WHERE finding_type = ?
          AND ((? IS NOT NULL AND record_id = ?) OR (? IS NULL AND object_key = ?))
          AND status <> 'RESOLVED')`)
    .bind(findingId, runId, finding.recordKind, finding.recordId, finding.objectKey,
      finding.findingType, finding.severity, lease.taskId, lease.token,
      finding.findingType, finding.recordId, finding.recordId, finding.recordId, finding.objectKey).run();
  const inserted = Boolean(result.meta.changes);
  if (inserted) {
    logEvent("error", "reconciliation.finding-created", {
      findingId,
      runId,
      findingType: finding.findingType,
      recordKind: finding.recordKind,
      recordId: finding.recordId,
      severity: finding.severity,
    });
  }
  return inserted;
}

async function storagePhaseSlice(
  dependencies: ReconciliationDependencies,
  lease: MaintenanceLease,
  run: ReconciliationRun,
  cursor: Extract<RunCursor, { phase: "STORAGE" }>,
  batchSize: number,
  minAgeMinutes: number,
) {
  const namespaces = storageNamespaces(dependencies);
  const namespace = namespaces[cursor.namespaceIndex];
  if (!namespace) {
    return { checked: 0, findings: 0, nextCursor: { phase: "DATABASE", cursor: null } as RunCursor, phaseDone: true };
  }
  const page = await namespace.inventory.list({
    cursor: cursor.cursor ?? undefined,
    limit: batchSize,
  });
  const recentThresholdMs = clock(dependencies).getTime() - minAgeMinutes * 60_000;
  let findings = 0;
  let unknownAge = 0;
  for (const object of page.objects) {
    await renewMaintenanceLease(dependencies.db, lease, LOCK_SECONDS);
    const known = await dependencies.db.prepare(`SELECT
        (SELECT id FROM binary_objects WHERE object_key = ?1 AND bucket_or_namespace = ?2 LIMIT 1) AS binary_id,
        (SELECT id FROM archive_documents WHERE storage_key = ?1 AND ?2 = 'ARCHIVE_FILES' LIMIT 1) AS document_id,
        EXISTS (SELECT 1 FROM promotion_jobs WHERE target_object_key = ?1 AND ?2 = 'ARCHIVE_FILES'
          AND (status NOT IN ('COMPLETED', 'FAILED') OR datetime(updated_at) > datetime(?3))) AS promotion_active
      FROM (SELECT 1)`).bind(object.key, namespace.name, new Date(recentThresholdMs).toISOString())
      .first<{ binary_id: string | null; document_id: string | null; promotion_active: number }>();
    if (known?.binary_id || known?.document_id || Boolean(known?.promotion_active)) continue;

    const uploadedMs = object.uploadedAt ? Date.parse(object.uploadedAt) : Number.NaN;
    if (!Number.isFinite(uploadedMs)) {
      unknownAge += 1;
      continue;
    }
    if (uploadedMs > recentThresholdMs) continue;

    await recordFinding(dependencies.db, lease, run.id, {
      recordKind: "STORAGE_OBJECT",
      recordId: null,
      objectKey: object.key,
      findingType: "ORPHAN_OBJECT",
      severity: "HIGH",
    });
    findings += 1;
  }
  if (unknownAge) {
    logEvent("warn", "reconciliation.object-age-unavailable", { runId: run.id, count: unknownAge });
  }
  const nextCursor: RunCursor = page.cursor
    ? { phase: "STORAGE", namespaceIndex: cursor.namespaceIndex, cursor: page.cursor }
    : cursor.namespaceIndex + 1 < namespaces.length
      ? { phase: "STORAGE", namespaceIndex: cursor.namespaceIndex + 1, cursor: null }
      : { phase: "DATABASE", cursor: null };
  return {
    checked: page.objects.length,
    findings,
    nextCursor,
    phaseDone: !page.cursor && cursor.namespaceIndex + 1 >= namespaces.length,
  };
}

async function databasePhaseSlice(
  dependencies: ReconciliationDependencies,
  lease: MaintenanceLease,
  run: ReconciliationRun,
  cursor: Extract<RunCursor, { phase: "DATABASE" }>,
  batchSize: number,
  minAgeMinutes: number,
) {
  const recentThreshold = new Date(clock(dependencies).getTime() - minAgeMinutes * 60_000).toISOString();
  const rows = await dependencies.db.prepare(`SELECT rowid AS scan_rowid, id, object_key, bucket_or_namespace
    FROM binary_objects
    WHERE rowid > ? AND rowid <= ? AND retention_status <> 'DISPOSED'
      AND object_class IN ('original', 'access', 'ocr', 'preservation', 'thumbnail')
      AND datetime(created_at) <= datetime(?)
    ORDER BY rowid LIMIT ?`).bind(cursor.cursor ?? 0, Number(run.binary_snapshot_max_rowid ?? 0),
      recentThreshold, batchSize).all<{
        scan_rowid: number; id: string; object_key: string; bucket_or_namespace: string;
      }>();
  let findings = 0;
  for (const row of rows.results) {
    await renewMaintenanceLease(dependencies.db, lease, LOCK_SECONDS);
    const namespace = storageNamespaces(dependencies).find((entry) => entry.name === row.bucket_or_namespace);
    if (!namespace) throw new Error(`Uzlaştırma okuma rolü yapılandırılmamış: ${row.bucket_or_namespace}`);
    const head = await namespace.reader.head(row.object_key);
    if (!head) {
      await recordFinding(dependencies.db, lease, run.id, {
        recordKind: "BINARY_OBJECT",
        recordId: row.id,
        objectKey: row.object_key,
        findingType: "MISSING_OBJECT",
        severity: "CRITICAL",
      });
      findings += 1;
    }
  }
  const done = rows.results.length < batchSize;
  const nextCursor: RunCursor = done
    ? { phase: "DOCUMENTS", cursor: null }
    : { phase: "DATABASE", cursor: Number(rows.results[rows.results.length - 1].scan_rowid) };
  return { checked: rows.results.length, findings, nextCursor, phaseDone: done };
}

/** Belge alındısı var fakat yetkili asıl `binary_objects` kaydı yok. */
async function documentPhaseSlice(
  dependencies: ReconciliationDependencies,
  lease: MaintenanceLease,
  run: ReconciliationRun,
  cursor: Extract<RunCursor, { phase: "DOCUMENTS" }>,
  batchSize: number,
  minAgeMinutes: number,
) {
  const recentThreshold = new Date(clock(dependencies).getTime() - minAgeMinutes * 60_000).toISOString();
  const rows = await dependencies.db.prepare(`SELECT d.rowid AS scan_rowid, d.id, d.storage_key
    FROM archive_documents d
    WHERE d.rowid > ? AND d.rowid <= ? AND datetime(d.created_at) <= datetime(?)
      AND NOT EXISTS (SELECT 1 FROM binary_objects b
        WHERE b.document_id = d.id AND b.object_class = 'original')
    ORDER BY d.rowid LIMIT ?`).bind(cursor.cursor ?? 0, Number(run.document_snapshot_max_rowid ?? 0),
      recentThreshold, batchSize).all<{ scan_rowid: number; id: string; storage_key: string }>();
  let findings = 0;
  for (const row of rows.results) {
    await renewMaintenanceLease(dependencies.db, lease, LOCK_SECONDS);
    await recordFinding(dependencies.db, lease, run.id, {
      recordKind: "ARCHIVE_DOCUMENT",
      recordId: row.id,
      objectKey: row.storage_key,
      findingType: "MISSING_RECORD",
      severity: "HIGH",
    });
    findings += 1;
  }
  const done = rows.results.length < batchSize;
  const nextCursor: RunCursor = {
    phase: "DOCUMENTS",
    cursor: rows.results.length ? Number(rows.results[rows.results.length - 1].scan_rowid) : cursor.cursor,
  };
  return { checked: rows.results.length, findings, nextCursor, phaseDone: done };
}

function fenced(results: D1Result<unknown>[], lease: MaintenanceLease) {
  if (!results.every((result) => Boolean(result.meta.changes))) {
    throw new MaintenanceLeaseLostError(lease.taskId);
  }
}

export async function runReconciliationSlice(
  dependencies: ReconciliationDependencies,
  options: { batchSize?: number; minAgeMinutes?: number } = {},
) {
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? 50), 1), 200);
  const minAgeMinutes = Math.max(options.minAgeMinutes ?? RECONCILIATION_MIN_AGE_MINUTES, 0);
  const db = dependencies.db;

  await ensureTask(db);
  const lease = await claimMaintenanceLease(db, RECONCILIATION_TASK, LOCK_SECONDS);
  if (!lease) return { claimed: false, checked: 0, findings: 0, done: false };

  try {
    const run = await ensureActiveRun(db, lease);
    const cursor = parseCursor(run.cursor);
    const slice = cursor.phase === "STORAGE"
      ? await storagePhaseSlice(dependencies, lease, run, cursor, batchSize, minAgeMinutes)
      : cursor.phase === "DATABASE"
        ? await databasePhaseSlice(dependencies, lease, run, cursor, batchSize, minAgeMinutes)
        : await documentPhaseSlice(dependencies, lease, run, cursor, batchSize, minAgeMinutes);

    const done = cursor.phase === "DOCUMENTS" && slice.phaseDone;
    const checked = Number(run.checked_count) + slice.checked;
    const results = await db.batch([
      done
        ? db.prepare(`UPDATE reconciliation_runs SET status = 'COMPLETED', cursor = ?,
            checked_count = ?, finding_count = finding_count + ?, completed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND EXISTS (SELECT 1 FROM maintenance_tasks
            WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)`)
          .bind(JSON.stringify(slice.nextCursor), checked, slice.findings,
            run.id, lease.taskId, lease.token)
        : db.prepare(`UPDATE reconciliation_runs SET cursor = ?, checked_count = ?,
            finding_count = finding_count + ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM maintenance_tasks
            WHERE id = ? AND status = 'RUNNING' AND lease_token = ?)`)
          .bind(JSON.stringify(slice.nextCursor), checked, slice.findings,
            run.id, lease.taskId, lease.token),
      db.prepare(`UPDATE maintenance_tasks SET status = ?, cursor = ?, processed = ?,
        lease_token = NULL, locked_until = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'RUNNING' AND lease_token = ?`)
        .bind(done ? "DONE" : "PENDING", JSON.stringify(slice.nextCursor), checked,
          lease.taskId, lease.token),
    ]);
    fenced(results, lease);
    logEvent(slice.findings ? "warn" : "info", done ? "reconciliation.run-completed" : "reconciliation.slice-completed", {
      runId: run.id, phase: cursor.phase, checked: slice.checked,
      findings: slice.findings, totalChecked: checked,
    });
    return { claimed: true, runId: run.id, phase: cursor.phase, checked: slice.checked, findings: slice.findings, done };
  } catch (error) {
    await failMaintenanceLease(db, lease, error);
    throw error;
  }
}
