/** Staging-only T-12 kontroll? iki y?nl? uzla?t?rma probu. */

import { digestToHex } from "./content-hasher.ts";
import {
  R2DispositionStorage, R2ImmutableVaultWriter, R2ObjectReader, R2StorageInventory,
} from "./r2-object-storage.ts";
import { ObjectStorageError } from "./object-storage.ts";
import {
  RECONCILIATION_MIN_AGE_MINUTES, RECONCILIATION_TASK, runReconciliationSlice,
} from "./reconciliation.ts";

const MAX_SLICES = 100;

async function sha256Text(value: string) {
  return digestToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function runAcceptanceReconciliationProbe(input: {
  db: D1Database;
  archive: R2Bucket;
  sessionId: string;
  now?: () => Date;
}) {
  const now = input.now?.() ?? new Date();
  const probeDigest = await sha256Text(`reconciliation:${input.sessionId}`);
  const probeId = probeDigest.slice(0, 24);
  const prefix = `acceptance/reconciliation/${probeId}`;
  const orphanKey = `${prefix}/orphan-object.bin`;
  const youngKey = `${prefix}/young-control.bin`;
  const missingKey = `${prefix}/missing-object.bin`;
  const missingDocumentId = `recon-doc-${probeId}`;
  const missingObjectId = `recon-obj-${probeId}`;
  const bytes = new TextEncoder().encode(`acceptance-reconciliation:${probeId}`);
  const contentSha = digestToHex(await crypto.subtle.digest("SHA-256", bytes));
  const oldIso = new Date(now.getTime() - (RECONCILIATION_MIN_AGE_MINUTES + 5) * 60_000).toISOString();

  const reader = new R2ObjectReader(input.archive);
  const writer = new R2ImmutableVaultWriter(input.archive, reader);
  const disposer = new R2DispositionStorage(input.archive);
  const putOptions = {
    contentType: "application/octet-stream",
    customMetadata: { objectClass: "acceptance-probe", sha256: contentSha },
    contentSha256Hex: contentSha,
  };
  const putProbe = async (key: string) => {
    try {
      await writer.putIfAbsent(key, bytes, putOptions);
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.code !== "KEY_ALREADY_EXISTS") throw error;
    }
  };
  await putProbe(orphanKey);
  await putProbe(youngKey);
  const execute = async () => {

  await input.db.prepare(`INSERT OR IGNORE INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
       document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, 'acceptance-missing.bin', ?, 'application/octet-stream', ?, ?,
      'Kabul uzla?t?rma probu', 'Kabul Testleri', 'queued', 'system:acceptance', ?, ?)`)
    .bind(missingDocumentId, `RECON-${probeId}`, missingKey, bytes.byteLength,
      contentSha, oldIso, oldIso).run();
  await input.db.prepare(`INSERT OR IGNORE INTO binary_objects
      (id, document_id, object_class, object_key, storage_provider, bucket_or_namespace,
       media_type, byte_size, sha256, generator, created_at)
    VALUES (?, ?, 'original', ?, 'r2', 'ARCHIVE_FILES', 'application/octet-stream',
      ?, ?, 'acceptance-reconciliation-probe', ?)`)
    .bind(missingObjectId, missingDocumentId, missingKey, bytes.byteLength, contentSha, oldIso).run();

  await input.db.prepare(`INSERT INTO maintenance_tasks (id, status, cursor, processed, total)
    VALUES (?, 'PENDING', NULL, 0, NULL) ON CONFLICT(id) DO NOTHING`)
    .bind(RECONCILIATION_TASK).run();
  await input.db.prepare(`UPDATE maintenance_tasks SET status = 'PENDING', cursor = NULL,
      processed = 0, lease_token = NULL, locked_until = NULL, last_error = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('DONE', 'FAILED')`)
    .bind(RECONCILIATION_TASK).run();

  const baseInventory = new R2StorageInventory(input.archive);
  const inventory = {
    async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
      const page = await baseInventory.list(options);
      return {
        ...page,
        objects: page.objects.map((object) => object.key === orphanKey
          ? { ...object, uploadedAt: oldIso } : object),
      };
    },
  };
  let result = { claimed: false, done: false, runId: "", checked: 0, findings: 0 };
  for (let index = 0; index < MAX_SLICES; index += 1) {
    const slice = await runReconciliationSlice({
      db: input.db, inventory, reader, now: () => now,
    }, { batchSize: 200, minAgeMinutes: RECONCILIATION_MIN_AGE_MINUTES });
    const runId = "runId" in slice && typeof slice.runId === "string" ? slice.runId : result.runId;
    result = { ...result, ...slice, runId };
    if (slice.done) break;
    if (!slice.claimed) throw new Error("Uzla?t?rma probu bak?m kiras?n? alamad?.");
  }
  if (!result.done || !result.runId) throw new Error("Uzla?t?rma probu dilim s?n?r?nda tamamlanamad?.");

  const run = await input.db.prepare(`SELECT id, status, binary_snapshot_max_rowid,
      document_snapshot_max_rowid, checked_count, finding_count, started_at, completed_at
    FROM reconciliation_runs WHERE id = ?`).bind(result.runId).first<Record<string, unknown>>();
  const findings = await input.db.prepare(`SELECT id, record_kind, record_id, object_key,
      finding_type, severity, status, created_at FROM reconciliation_findings
    WHERE run_id = ? AND (object_key IN (?, ?) OR record_id = ?) ORDER BY finding_type`)
    .bind(result.runId, orphanKey, youngKey, missingObjectId).all<Record<string, unknown>>();
  const orphanPresent = Boolean(await reader.head(orphanKey));

  const safeFindings = await Promise.all(findings.results.map(async (finding) => ({
    id: finding.id,
    recordKind: finding.record_kind,
    recordId: finding.record_id,
    objectKeyDigest: finding.object_key ? await sha256Text(String(finding.object_key)) : null,
    findingType: finding.finding_type,
    severity: finding.severity,
    status: finding.status,
    createdAt: finding.created_at,
  })));

  return {
    run: {
      id: run?.id ?? result.runId,
      status: run?.status ?? null,
      binarySnapshotMaxRowid: Number(run?.binary_snapshot_max_rowid ?? 0),
      documentSnapshotMaxRowid: Number(run?.document_snapshot_max_rowid ?? 0),
      checkedCount: Number(run?.checked_count ?? 0),
      findingCount: Number(run?.finding_count ?? 0),
      startedAt: run?.started_at ?? null,
      completedAt: run?.completed_at ?? null,
    },
    findings: safeFindings,
    expectations: {
      orphanKeyDigest: await sha256Text(orphanKey),
      missingObjectId,
      youngKeyDigest: await sha256Text(youngKey),
      orphanObjectStillPresent: orphanPresent,
      youngControlFindingCount: findings.results.filter((finding) => finding.object_key === youngKey).length,
    },
  };
  };
  try {
    return await execute();
  } finally {
    await disposer.delete(youngKey).catch(() => undefined);
  }
}
