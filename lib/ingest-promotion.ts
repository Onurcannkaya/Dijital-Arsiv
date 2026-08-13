import { prepareAuditEvent } from "./audit.ts";
import { prepareIngestTransition, transitionIngestSession } from "./ingest-events.ts";
import { resolveDocumentProfile } from "./document-profile.ts";
import {
  isObjectStorageError,
  type ImmutableVaultWriter,
  type ObjectReader,
  type ObjectStat,
} from "./object-storage.ts";
import type { StreamingHasher, StreamDigest } from "./content-hasher.ts";

export const PROMOTION_LEASE_MS = 12 * 60 * 1000;
const ENCRYPTION_STATUS = "provider-managed";

type PromotionJob = {
  id: string;
  upload_session_id: string;
  ingest_receipt_id: string;
  document_id: string;
  binary_object_id: string;
  target_object_key: string;
  sha256: string;
  attempt: number;
  max_attempts: number;
  lease_token: string;
};

type PromotionContext = PromotionJob & {
  session_status: "VERIFIED" | "PROMOTING";
  user_id: string;
  unit: string;
  original_name: string;
  requested_document_type: string;
  declared_media_type: string;
  source_object_key: string;
  byte_size: number;
  quarantine_sha256: string;
  receipt_result: "VERIFIED";
  detected_media_type: string;
  type_validation_result: "MATCH";
  parser_result: "VALID";
  scanner_result: "CLEAN";
};

export type PromotionDependencies = {
  db: D1Database;
  quarantineReader: ObjectReader;
  vaultWriter: ImmutableVaultWriter;
  vaultReader: ObjectReader;
  hasher: StreamingHasher;
  now?: () => Date;
  randomId?: () => string;
};

function clock(dependencies: PromotionDependencies) {
  return dependencies.now?.() ?? new Date();
}

function randomId(dependencies: PromotionDependencies) {
  return dependencies.randomId?.() ?? crypto.randomUUID();
}

function targetKey(documentId: string, binaryObjectId: string) {
  // Önek sözleşmesi: OCR servisi yalnız `originals/` ile başlayan anahtarları
  // okur (services/ocr/app/main.py) ve eski yükleme yolu da aynı öneki üretti.
  return `originals/${documentId}/${binaryObjectId}`;
}

async function findAcceptedDuplicate(db: D1Database, sha256: string) {
  return db.prepare(`SELECT document_id FROM binary_objects
    WHERE object_class = 'original' AND sha256 = ? LIMIT 1`)
    .bind(sha256).first<{ document_id: string }>();
}

async function markDuplicate(
  dependencies: PromotionDependencies,
  sessionId: string,
  ingestReceiptId: string,
  documentId: string,
  job?: PromotionJob,
) {
  const transition = await prepareIngestTransition(dependencies.db, {
    sessionId,
    to: "DUPLICATE",
    actor: { kind: "service", id: "ingest-promotion" },
    ingestReceiptId,
    duplicateOfDocumentId: documentId,
    eventId: randomId(dependencies),
    now: clock(dependencies).toISOString(),
  });
  const statements = [...transition.statements];
  if (job) {
    statements.push(dependencies.db.prepare(`UPDATE promotion_jobs SET status = 'COMPLETED',
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
      last_error = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`)
      .bind(clock(dependencies).toISOString(), job.id, job.lease_token));
  }
  await dependencies.db.batch(statements);
  return { processed: true, result: "DUPLICATE" as const, duplicateOfDocumentId: documentId };
}

async function ensurePendingJob(dependencies: PromotionDependencies) {
  await dependencies.db.prepare(`UPDATE promotion_jobs SET status = 'COMPLETED',
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
    WHERE status <> 'COMPLETED' AND EXISTS (
      SELECT 1 FROM upload_sessions s WHERE s.id = promotion_jobs.upload_session_id
        AND s.status IN ('ACCEPTED', 'DUPLICATE')
    )`).bind(clock(dependencies).toISOString()).run();

  const pending = await dependencies.db.prepare(`SELECT s.id AS upload_session_id,
      r.id AS ingest_receipt_id, r.sha256
    FROM upload_sessions s
    INNER JOIN ingest_receipts r ON r.upload_session_id = s.id AND r.result = 'VERIFIED'
    LEFT JOIN promotion_jobs own_job ON own_job.upload_session_id = s.id
    WHERE s.status = 'VERIFIED' AND own_job.id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM promotion_jobs active_job
        WHERE active_job.sha256 = r.sha256 AND active_job.status <> 'FAILED'
      )
    ORDER BY s.updated_at LIMIT 1`)
    .first<{ upload_session_id: string; ingest_receipt_id: string; sha256: string }>();
  if (!pending) return null;

  const duplicate = await findAcceptedDuplicate(dependencies.db, pending.sha256);
  if (duplicate) {
    return await markDuplicate(
      dependencies,
      pending.upload_session_id,
      pending.ingest_receipt_id,
      duplicate.document_id,
    );
  }

  const documentId = randomId(dependencies);
  const binaryObjectId = randomId(dependencies);
  await dependencies.db.prepare(`INSERT OR IGNORE INTO promotion_jobs
      (id, upload_session_id, ingest_receipt_id, document_id, binary_object_id,
       target_object_key, sha256, status, attempt, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, 5, ?, ?)`)
    .bind(randomId(dependencies), pending.upload_session_id, pending.ingest_receipt_id,
      documentId, binaryObjectId, targetKey(documentId, binaryObjectId), pending.sha256,
      clock(dependencies).toISOString(), clock(dependencies).toISOString()).run();
  return null;
}

async function claimJob(dependencies: PromotionDependencies) {
  const finalized = await ensurePendingJob(dependencies);
  if (finalized) return { finalized };
  const now = clock(dependencies);
  const nowIso = now.toISOString();
  const leaseToken = randomId(dependencies);
  const leaseUntil = new Date(now.getTime() + PROMOTION_LEASE_MS).toISOString();
  return dependencies.db.prepare(`UPDATE promotion_jobs SET
      status = 'PROMOTING', attempt = attempt + 1, lease_token = ?,
      lease_expires_at = ?, last_error = NULL, updated_at = ?
    WHERE id = (
      SELECT j.id FROM promotion_jobs j
      INNER JOIN upload_sessions s ON s.id = j.upload_session_id
      WHERE s.status IN ('VERIFIED', 'PROMOTING')
        AND j.attempt < j.max_attempts
        AND (
          (j.status IN ('QUEUED', 'RETRY') AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?))
          OR (j.status = 'PROMOTING' AND j.lease_expires_at <= ?)
        )
      ORDER BY j.created_at LIMIT 1
    )
    RETURNING id, upload_session_id, ingest_receipt_id, document_id,
      binary_object_id, target_object_key, sha256, attempt, max_attempts, lease_token`)
    .bind(leaseToken, leaseUntil, nowIso, nowIso, nowIso).first<PromotionJob>();
}

async function loadContext(db: D1Database, jobId: string) {
  return db.prepare(`SELECT j.id, j.upload_session_id, j.ingest_receipt_id,
      j.document_id, j.binary_object_id, j.target_object_key, j.sha256,
      j.attempt, j.max_attempts, j.lease_token,
      s.status AS session_status, s.user_id, s.unit, s.original_name,
      s.requested_document_type, s.declared_media_type,
      o.object_key AS source_object_key, o.byte_size, o.sha256 AS quarantine_sha256,
      r.result AS receipt_result, r.detected_media_type, r.type_validation_result,
      r.parser_result, r.scanner_result
    FROM promotion_jobs j
    INNER JOIN upload_sessions s ON s.id = j.upload_session_id
    INNER JOIN ingest_objects o ON o.upload_session_id = s.id
      AND o.object_class = 'quarantine' AND o.deleted_at IS NULL
    INNER JOIN ingest_receipts r ON r.id = j.ingest_receipt_id
      AND r.upload_session_id = s.id
    WHERE j.id = ?`).bind(jobId).first<PromotionContext>();
}

function assertEvidence(context: PromotionContext) {
  if (context.receipt_result !== "VERIFIED"
    || context.type_validation_result !== "MATCH"
    || context.parser_result !== "VALID"
    || context.scanner_result !== "CLEAN"
    || context.sha256 !== context.quarantine_sha256
    || !/^[a-f0-9]{64}$/.test(context.sha256)
    || !Number.isSafeInteger(context.byte_size) || context.byte_size < 1) {
    throw new Error("Promotion evidence is incomplete or inconsistent.");
  }
}

async function stillOwnsLease(db: D1Database, job: PromotionJob) {
  const row = await db.prepare(`SELECT 1 AS ok FROM promotion_jobs
    WHERE id = ? AND status = 'PROMOTING' AND lease_token = ?`)
    .bind(job.id, job.lease_token).first();
  return Boolean(row);
}

function verifyProviderStat(stat: ObjectStat, context: PromotionContext) {
  if (stat.size !== context.byte_size) {
    throw new Error("Vault object size does not match quarantine evidence.");
  }
  if (stat.providerChecksumSha256 && stat.providerChecksumSha256.toLowerCase() !== context.sha256) {
    throw new Error("Provider checksum does not match quarantine evidence.");
  }
}

async function readAndVerifyVault(
  dependencies: PromotionDependencies,
  context: PromotionContext,
): Promise<{ stat: ObjectStat; digest: StreamDigest }> {
  const object = await dependencies.vaultReader.get(context.target_object_key);
  if (!object || object.range !== null) {
    // Teşhis kaydı: "tam okunamadı" tek başına sebebini saklıyor ve yerelde
    // Miniflare aralık davranışını ayıklarken saatlere mal oluyordu.
    throw new Error(`Promoted vault object cannot be read in full (exists=${Boolean(object)}, range=${JSON.stringify(object?.range ?? null)}, size=${object?.size ?? "?"}, bodySize=${object?.bodySize ?? "?"}).`);
  }
  verifyProviderStat(object, context);
  if (object.bodySize !== context.byte_size) {
    throw new Error("Vault response body size does not match quarantine evidence.");
  }
  const digest = await dependencies.hasher.sha256(object.body);
  if (digest.byteSize !== context.byte_size || digest.sha256Hex !== context.sha256) {
    throw new Error("Post-write full SHA-256 verification failed.");
  }
  return { stat: object, digest };
}

async function finalizeAcceptance(
  dependencies: PromotionDependencies,
  context: PromotionContext,
  stat: ObjectStat,
  digest: StreamDigest,
) {
  const now = clock(dependencies);
  const nowIso = now.toISOString();
  const profile = await resolveDocumentProfile(dependencies.db, {
    documentType: context.requested_document_type,
  });
  const referenceNo = `ARS-${now.getUTCFullYear()}-${context.document_id.slice(0, 8).toUpperCase()}`;
  const audit = await prepareAuditEvent(dependencies.db, {
    documentId: context.document_id,
    actor: "system:ingest-promotion",
    action: "document.received",
    details: {
      referenceNo,
      uploadSessionId: context.upload_session_id,
      ingestReceiptId: context.ingest_receipt_id,
      sha256: digest.sha256Hex,
      byteSize: digest.byteSize,
      mediaType: context.detected_media_type,
      objectClass: "original",
      storageVersionId: stat.providerVersionId,
      encryptionStatus: ENCRYPTION_STATUS,
      profileCode: profile.code,
      profileVersion: profile.profileVersion,
    },
  });
  const transition = await prepareIngestTransition(dependencies.db, {
    sessionId: context.upload_session_id,
    to: "ACCEPTED",
    actor: { kind: "service", id: "ingest-promotion" },
    ingestReceiptId: context.ingest_receipt_id,
    eventId: randomId(dependencies),
    now: nowIso,
  });
  if (!transition.changed) throw new Error("Promotion session was already finalized.");
  const promotionReceiptId = randomId(dependencies);
  const ocrJobId = randomId(dependencies);

  await dependencies.db.batch([
    dependencies.db.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
       document_type, document_type_id, document_profile_version, unit, status,
       uploaded_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM promotion_jobs
        WHERE id = ? AND status = 'PROMOTING' AND lease_token = ?)`)
      .bind(context.document_id, referenceNo, context.original_name, context.target_object_key,
        context.detected_media_type, digest.byteSize, digest.sha256Hex, profile.name,
        profile.documentTypeId, profile.profileVersion, context.unit, context.user_id, nowIso, nowIso,
        context.id, context.lease_token),
    dependencies.db.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, storage_provider, bucket_or_namespace,
       storage_version_id, media_type, byte_size, sha256, encryption_status, generator, created_at)
      VALUES (?, ?, 'original', ?, 'r2', 'ARCHIVE_FILES', ?, ?, ?, ?, ?, 'ingest-promotion', ?)`)
      .bind(context.binary_object_id, context.document_id, context.target_object_key,
        stat.providerVersionId, context.detected_media_type, digest.byteSize, digest.sha256Hex,
        ENCRYPTION_STATUS, nowIso),
    dependencies.db.prepare(`INSERT INTO promotion_receipts
      (id, promotion_job_id, lease_token, upload_session_id, ingest_receipt_id, result,
       document_id, binary_object_id, source_object_key, target_object_key,
       quarantine_sha256, vault_sha256, expected_byte_size, vault_byte_size,
       vault_storage_version_id, provider_etag, provider_checksum_sha256,
       encryption_status, created_at)
      VALUES (?, ?, ?, ?, ?, 'VERIFIED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(promotionReceiptId, context.id, context.lease_token, context.upload_session_id, context.ingest_receipt_id,
        context.document_id, context.binary_object_id, context.source_object_key,
        context.target_object_key, context.quarantine_sha256, digest.sha256Hex,
        context.byte_size, digest.byteSize, stat.providerVersionId, stat.etag,
        stat.providerChecksumSha256, ENCRYPTION_STATUS, nowIso),
    dependencies.db.prepare(`INSERT INTO processing_jobs
      (id, document_id, kind, status, attempt, max_attempts, model, created_at, updated_at)
      VALUES (?, ?, 'ocr', 'queued', 0, 3, 'paddleocr-local', ?, ?)`)
      .bind(ocrJobId, context.document_id, nowIso, nowIso),
    audit.statement,
    ...transition.statements,
    dependencies.db.prepare(`UPDATE promotion_jobs SET status = 'COMPLETED',
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
      last_error = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`)
      .bind(nowIso, context.id, context.lease_token),
  ]);
  return {
    processed: true,
    result: "ACCEPTED" as const,
    documentId: context.document_id,
    binaryObjectId: context.binary_object_id,
    promotionReceiptId,
    ocrJobId,
  };
}

function failureCode(error: unknown) {
  if (isObjectStorageError(error)) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /SHA-256|checksum|size|version|ETag/i.test(message) ? "VAULT_VERIFICATION_FAILED" : "PROMOTION_FAILED";
}

async function recordFailure(
  dependencies: PromotionDependencies,
  context: PromotionContext,
  error: unknown,
) {
  const now = clock(dependencies);
  const nowIso = now.toISOString();
  const terminal = context.attempt >= context.max_attempts;
  const delay = Math.min(3600, 30 * (2 ** Math.max(0, context.attempt - 1)));
  const nextAttempt = new Date(now.getTime() + delay * 1000).toISOString();
  const code = failureCode(error);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const statements = [
    dependencies.db.prepare(`INSERT INTO promotion_receipts
      (id, promotion_job_id, lease_token, upload_session_id, ingest_receipt_id, result,
       source_object_key, target_object_key, quarantine_sha256, expected_byte_size,
       encryption_status, failure_code, failure_message, created_at)
      VALUES (?, ?, ?, ?, ?, 'FAILED', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(randomId(dependencies), context.id, context.lease_token,
        context.upload_session_id, context.ingest_receipt_id, context.source_object_key, context.target_object_key,
        context.quarantine_sha256, context.byte_size, ENCRYPTION_STATUS, code, message, nowIso),
    dependencies.db.prepare(`UPDATE promotion_jobs SET status = ?, next_attempt_at = ?,
      lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND lease_token = ?`)
      .bind(terminal ? "FAILED" : "RETRY", terminal ? null : nextAttempt,
        message, nowIso, context.id, context.lease_token),
  ];
  const session = await dependencies.db.prepare("SELECT status FROM upload_sessions WHERE id = ?")
    .bind(context.upload_session_id).first<{ status: string }>();
  if (terminal && session?.status === "PROMOTING") {
    const transition = await prepareIngestTransition(dependencies.db, {
      sessionId: context.upload_session_id,
      to: "FAILED",
      actor: { kind: "service", id: "ingest-promotion" },
      ingestReceiptId: context.ingest_receipt_id,
      failureCode: code,
      reason: message,
      eventId: randomId(dependencies),
      now: nowIso,
    });
    statements.push(...transition.statements);
  }
  await dependencies.db.batch(statements);
}

export async function processNextPromotionJob(dependencies: PromotionDependencies) {
  const job = await claimJob(dependencies);
  if (!job) return { processed: false };
  if ("finalized" in job) return job.finalized;
  const context = await loadContext(dependencies.db, job.id);
  if (!context) throw new Error("Promotion job evidence cannot be loaded.");

  try {
    assertEvidence(context);
    const duplicate = await findAcceptedDuplicate(dependencies.db, context.sha256);
    if (duplicate) {
      return await markDuplicate(
        dependencies,
        context.upload_session_id,
        context.ingest_receipt_id,
        duplicate.document_id,
        context,
      );
    }
    if (context.session_status === "VERIFIED") {
      await transitionIngestSession(dependencies.db, {
        sessionId: context.upload_session_id,
        to: "PROMOTING",
        actor: { kind: "service", id: "ingest-promotion" },
        ingestReceiptId: context.ingest_receipt_id,
        eventId: randomId(dependencies),
        now: clock(dependencies).toISOString(),
      });
    }

    let promoted: ObjectStat;
    try {
      promoted = await dependencies.vaultWriter.promote(
        context.source_object_key,
        context.target_object_key,
        {
          contentType: context.detected_media_type,
          contentSha256Hex: context.sha256,
          customMetadata: {
            sha256: context.sha256,
            documentId: context.document_id,
            binaryObjectId: context.binary_object_id,
            objectClass: "original",
          },
        },
      );
    } catch (error) {
      if (!isObjectStorageError(error, "KEY_ALREADY_EXISTS")) throw error;
      const existing = await dependencies.vaultReader.head(context.target_object_key);
      if (!existing) throw error;
      promoted = existing;
    }
    verifyProviderStat(promoted, context);
    const verified = await readAndVerifyVault(dependencies, context);
    if (promoted.providerVersionId && verified.stat.providerVersionId
      && promoted.providerVersionId !== verified.stat.providerVersionId) {
      throw new Error("Vault object version changed between write and verification.");
    }
    if (promoted.etag && verified.stat.etag && promoted.etag !== verified.stat.etag) {
      throw new Error("Vault object ETag changed between write and verification.");
    }
    if (!(await stillOwnsLease(dependencies.db, context))) {
      return { processed: true, stale: true };
    }

    const raceWinner = await findAcceptedDuplicate(dependencies.db, context.sha256);
    if (raceWinner) {
      return await markDuplicate(
        dependencies,
        context.upload_session_id,
        context.ingest_receipt_id,
        raceWinner.document_id,
        context,
      );
    }
    return await finalizeAcceptance(dependencies, context, verified.stat, verified.digest);
  } catch (error) {
    if (await stillOwnsLease(dependencies.db, context)) {
      await recordFailure(dependencies, context, error);
    }
    return { processed: true, result: "FAILED" as const, errorCode: failureCode(error) };
  }
}
