/** Staging-only T-08 tam-SHA uyu?mazl??? ve ge?ici hata probu. */
import { createDigestStreamHasher, digestToHex } from "./content-hasher.ts";
import { evaluateFullIntegrityObject } from "./integrity.ts";
import { logEvent } from "./observability.ts";
import { R2ObjectReader } from "./r2-object-storage.ts";

type TargetRow = {
  scan_rowid: number;
  id: string;
  object_key: string;
  byte_size: number;
  sha256: string;
  storage_version_id: string | null;
  bucket_or_namespace: string;
};

async function sha256Text(value: string) {
  return digestToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function runAcceptanceIntegrityProbe(input: {
  db: D1Database;
  archive: R2Bucket;
  sessionId: string;
}) {
  const target = await input.db.prepare(`SELECT b.rowid AS scan_rowid, b.id, b.object_key,
      b.byte_size, b.sha256, b.storage_version_id, b.bucket_or_namespace
    FROM promotion_jobs p INNER JOIN binary_objects b ON b.id = p.binary_object_id
    WHERE p.upload_session_id = ? AND p.status = 'COMPLETED'
      AND b.object_class = 'original' AND b.bucket_or_namespace = 'ARCHIVE_FILES'
    LIMIT 1`).bind(input.sessionId).first<TargetRow>();
  if (!target) throw new Error("B?t?nl?k kabul probu i?in as?l nesne bulunamad?.");

  const base = new R2ObjectReader(input.archive);
  const hasher = createDigestStreamHasher();
  const targetInput = {
    id: target.id,
    objectKey: target.object_key,
    byteSize: Number(target.byte_size),
    sha256: target.sha256,
    storageVersionId: target.storage_version_id,
    namespace: target.bucket_or_namespace,
  };

  let transientRejected = false;
  try {
    await evaluateFullIntegrityObject({
      head: (key: string) => base.head(key),
      get: async () => { throw new Error("ACCEPTANCE_TRANSIENT_PROVIDER_FAILURE"); },
    }, hasher, targetInput);
  } catch {
    transientRejected = true;
  }

  const corruptingReader = {
    head: (key: string) => base.head(key),
    async get(key: string) {
      const object = await base.get(key);
      if (!object) return null;
      let flipped = false;
      const corruption = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const copy = chunk.slice();
          if (!flipped && copy.byteLength) {
            copy[0] ^= 1;
            flipped = true;
          }
          controller.enqueue(copy);
        },
      });
      return { ...object, body: object.body.pipeThrough(corruption) };
    },
  };
  const finding = await evaluateFullIntegrityObject(corruptingReader, hasher, targetInput);
  if (!finding || finding.findingType !== "HASH_MISMATCH") {
    throw new Error("Kontroll? tam-SHA uyu?mazl??? saptanamad?.");
  }

  const runId = crypto.randomUUID();
  const findingId = crypto.randomUUID();
  await input.db.batch([
    input.db.prepare(`INSERT INTO integrity_runs
      (id, status, profile, cursor, snapshot_max_rowid, checked_count,
       finding_count, started_at, completed_at)
      VALUES (?, 'COMPLETED', 'full', ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .bind(runId, String(target.scan_rowid), target.scan_rowid),
    input.db.prepare(`INSERT INTO integrity_findings
      (id, run_id, binary_object_id, object_key, finding_type, expected_sha256,
       actual_sha256, severity, status, created_at)
      VALUES (?, ?, ?, ?, 'HASH_MISMATCH', ?, ?, 'CRITICAL', 'OPEN', CURRENT_TIMESTAMP)`)
      .bind(findingId, runId, target.id, target.object_key,
        finding.expectedSha256, finding.actualSha256),
  ]);
  logEvent("error", "integrity.finding-created", {
    findingId, runId, objectId: target.id,
    findingType: "HASH_MISMATCH", severity: "CRITICAL",
  });

  const unchangedObject = await base.get(target.object_key);
  if (!unchangedObject) throw new Error("B?t?nl?k probu sonras?nda as?l bulunamad?.");
  const unchangedDigest = await hasher.sha256(unchangedObject.body);
  return {
    run: {
      id: runId,
      status: "COMPLETED",
      profile: "full",
      snapshotMaxRowid: Number(target.scan_rowid),
      checkedCount: 1,
      findingCount: 1,
    },
    finding: {
      id: findingId,
      binaryObjectId: target.id,
      objectKeyDigest: await sha256Text(target.object_key),
      findingType: "HASH_MISMATCH",
      expectedSha256: finding.expectedSha256,
      actualSha256: finding.actualSha256,
      severity: "CRITICAL",
      status: "OPEN",
    },
    alarm: {
      event: "integrity.finding-created",
      correlationId: findingId,
    },
    transientProviderFailure: {
      propagatedForRetry: transientRejected,
      persistedFindingCount: 0,
    },
    originalAfterProbe: {
      sha256: unchangedDigest.sha256Hex,
      byteSize: unchangedDigest.byteSize,
      unchanged: unchangedDigest.sha256Hex === target.sha256
        && unchangedDigest.byteSize === Number(target.byte_size),
    },
  };
}
