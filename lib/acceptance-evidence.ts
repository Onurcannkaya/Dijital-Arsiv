import { digestToHex } from "./content-hasher.ts";
import {
  buildPortableManifest, manifestDigest, validatePortableManifest, verifyAuditChain,
} from "./storage-manifest.ts";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

type SessionRow = {
  id: string;
  status: string;
  state_version: number;
  duplicate_of_document_id: string | null;
};

type ReceiptRow = {
  id: string;
  result: "VERIFIED" | "REJECTED" | "FAILED";
  sha256: string;
  byte_size: number;
  declared_media_type: string;
  detected_media_type: string;
  type_validation_result: "MATCH" | "MISMATCH" | "UNSUPPORTED";
  parser_name: string;
  parser_version: string;
  parser_result: "VALID" | "INVALID" | "ERROR";
  scanner_engine: string;
  scanner_version: string;
  scanner_signature_version: string;
  scanner_result: "CLEAN" | "MALICIOUS" | "ERROR";
  created_at: string;
};

type EventRow = {
  event_number: number;
  from_status: string;
  to_status: string;
  actor_kind: "user" | "operator" | "service";
  actor_id: string;
  reason: string | null;
  ingest_receipt_id: string | null;
  event_hash: string;
  created_at: string;
};

type CountRow = {
  document_count: number;
  original_count: number;
  ocr_job_count: number;
  verified_promotion_count: number;
};


type OriginalInventoryRow = {
  id: string;
  sha256: string;
  byte_size: number;
  storage_version_id: string | null;
};

type DerivativeInventoryRow = {
  id: string;
  sha256: string;
  byte_size: number;
  media_type: string;
  derived_from_id: string | null;
  generator: string | null;
  derivative_generation_id: string | null;
  page_start: number | null;
  page_end: number | null;
};

type DerivativeJobRow = {
  id: string;
  source_binary_object_id: string;
  profile_version: string;
  status: string;
  renderer: string | null;
  renderer_version: string | null;
  renderer_image_digest: string | null;
  page_count: number | null;
  segment_count: number | null;
  completed_at: string | null;
};

type AcceptanceDocumentRow = {
  document_id: string;
  binary_object_id: string;
};

type PrivateObjectLocatorRow = {
  object_key: string;
  sha256: string | null;
  byte_size: number;
  object_class: "original" | "quarantine";
};


type AccessAuditRow = {
  event_number: number;
  action: string;
  details_json: string;
  created_at: string;
};
type KeyMigrationCountRow = {
  status: string;
  count: number;
};
export const ACCEPTANCE_SECOND_DERIVATIVE_PROFILE = "access-pdf-v2";
export class AcceptanceEvidenceNotFoundError extends Error {
  constructor() {
    super("Kabul oturumu bulunamad?.");
    this.name = "AcceptanceEvidenceNotFoundError";
  }
}

export function isSafeAcceptanceSessionId(value: string) {
  return SAFE_SESSION_ID.test(value);
}

async function sha256Text(value: string) {
  return digestToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function canonicalEvent(row: EventRow, sessionId: string, previousHash: string | null) {
  return JSON.stringify({
    sessionId,
    eventNumber: row.event_number,
    from: row.from_status,
    to: row.to_status,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    reason: row.reason,
    ingestReceiptId: row.ingest_receipt_id,
    previousHash,
    createdAt: row.created_at,
  });
}

async function verifyEventChain(session: SessionRow, events: EventRow[]) {
  let previousHash: string | null = null;
  let previousStatus = "CREATED";
  let valid = true;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedHash = await sha256Text(canonicalEvent(event, session.id, previousHash));
    if (event.event_number !== index + 1
      || event.from_status !== previousStatus
      || event.event_hash !== expectedHash) valid = false;
    previousHash = event.event_hash;
    previousStatus = event.to_status;
  }
  if (events.length !== session.state_version || previousStatus !== session.status) valid = false;
  return {
    valid,
    headHash: previousHash,
    events: events.map((event) => ({
      number: event.event_number,
      from: event.from_status,
      to: event.to_status,
      actorKind: event.actor_kind,
      createdAt: event.created_at,
    })),
  };
}

function preferredReceipt(status: string, receipts: ReceiptRow[]) {
  const expected = status === "REJECTED" ? "REJECTED"
    : ["VERIFIED", "PROMOTING", "ACCEPTED", "DUPLICATE"].includes(status) ? "VERIFIED" : null;
  return (expected ? receipts.find((receipt) => receipt.result === expected) : null)
    ?? receipts[0] ?? null;
}

function decisionCode(status: string, receipt: ReceiptRow | null) {
  if (status === "DUPLICATE") return "DUPLICATE";
  if (receipt?.type_validation_result === "MISMATCH") return "TYPE_MISMATCH";
  if (receipt?.type_validation_result === "UNSUPPORTED") return "UNSUPPORTED_TYPE";
  if (receipt?.parser_result === "INVALID") return "PARSER_INVALID";
  if (receipt?.parser_result === "ERROR") return "PARSER_ERROR";
  if (receipt?.scanner_result === "MALICIOUS") return "MALWARE_DETECTED";
  if (receipt?.scanner_result === "ERROR") return "CONTENT_SCAN_ERROR";
  if (receipt?.result === "VERIFIED" && status === "ACCEPTED") return "ACCEPTED_AND_VERIFIED";
  if (receipt?.result === "VERIFIED") return "CONTENT_VERIFIED";
  return status === "FAILED" ? "INGEST_FAILED" : "INCONCLUSIVE";
}

function safeReceipt(receipt: ReceiptRow | null) {
  if (!receipt) return null;
  return {
    id: receipt.id,
    result: receipt.result,
    sha256: receipt.sha256,
    byteSize: Number(receipt.byte_size),
    declaredMediaType: receipt.declared_media_type,
    detectedMediaType: receipt.detected_media_type,
    typeValidationResult: receipt.type_validation_result,
    parserName: receipt.parser_name,
    parserVersion: receipt.parser_version,
    parserResult: receipt.parser_result,
    scannerEngine: receipt.scanner_engine,
    scannerVersion: receipt.scanner_version,
    scannerSignatureVersion: receipt.scanner_signature_version,
    scannerResult: receipt.scanner_result,
    createdAt: receipt.created_at,
  };
}


function safeAccessAudit(row: AccessAuditRow) {
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(row.details_json) as Record<string, unknown>; } catch { /* bozuk ayr?nt? maskelenir */ }
  const safeDetails = row.action === "document.ticket-issued"
    ? { scope: details.scope ?? null, purpose: details.purpose ?? null, objectClass: details.objectClass ?? null }
    : row.action === "document.viewed"
      ? { servedObjectClass: details.servedObjectClass ?? null, purpose: details.purpose ?? null, ranged: details.ranged ?? null }
      : { reason: details.reason ?? null };
  return {
    eventNumber: Number(row.event_number),
    action: row.action,
    details: safeDetails,
    createdAt: row.created_at,
  };
}
export async function readAcceptanceEvidence(db: D1Database, sessionId: string) {
  if (!isSafeAcceptanceSessionId(sessionId)) throw new AcceptanceEvidenceNotFoundError();
  const session = await db.prepare(
    "SELECT id, status, state_version, duplicate_of_document_id FROM upload_sessions WHERE id = ?",
  ).bind(sessionId).first<SessionRow>();
  if (!session) throw new AcceptanceEvidenceNotFoundError();

  const receiptQuery = db.prepare(
    "SELECT id, result, sha256, byte_size, declared_media_type, detected_media_type, "
    + "type_validation_result, parser_name, parser_version, parser_result, scanner_engine, "
    + "scanner_version, scanner_signature_version, scanner_result, created_at "
    + "FROM ingest_receipts WHERE upload_session_id = ? ORDER BY created_at DESC, rowid DESC",
  ).bind(sessionId).all<ReceiptRow>();
  const eventQuery = db.prepare(
    "SELECT event_number, from_status, to_status, actor_kind, actor_id, reason, "
    + "ingest_receipt_id, event_hash, created_at FROM upload_session_events "
    + "WHERE upload_session_id = ? ORDER BY event_number ASC",
  ).bind(sessionId).all<EventRow>();
  const countQuery = db.prepare(
    "SELECT "
    + "(SELECT COUNT(DISTINCT d.id) FROM promotion_jobs p INNER JOIN archive_documents d "
    + "ON d.id = p.document_id WHERE p.upload_session_id = ?) AS document_count, "
    + "(SELECT COUNT(DISTINCT b.id) FROM promotion_jobs p INNER JOIN binary_objects b "
    + "ON b.id = p.binary_object_id AND b.object_class = 'original' "
    + "WHERE p.upload_session_id = ?) AS original_count, "
    + "(SELECT COUNT(DISTINCT j.id) FROM promotion_jobs p INNER JOIN processing_jobs j "
    + "ON j.document_id = p.document_id AND j.kind = 'ocr' "
    + "WHERE p.upload_session_id = ?) AS ocr_job_count, "
    + "(SELECT COUNT(*) FROM promotion_receipts r WHERE r.upload_session_id = ? "
    + "AND r.result = 'VERIFIED') AS verified_promotion_count",
  ).bind(sessionId, sessionId, sessionId, sessionId).first<CountRow>();
  const originalQuery = db.prepare(`SELECT DISTINCT b.id, b.sha256, b.byte_size, b.storage_version_id
    FROM promotion_jobs p INNER JOIN binary_objects b ON b.id = p.binary_object_id
    WHERE p.upload_session_id = ? AND b.object_class = 'original' ORDER BY b.id`)
    .bind(sessionId).all<OriginalInventoryRow>();
  const derivativeQuery = db.prepare(`SELECT DISTINCT b.id, b.sha256, b.byte_size, b.media_type,
      b.derived_from_id, b.generator, b.derivative_generation_id, b.page_start, b.page_end
    FROM promotion_jobs p INNER JOIN binary_objects b ON b.document_id = p.document_id
    WHERE p.upload_session_id = ? AND b.object_class = 'access'
    ORDER BY b.derivative_generation_id, b.page_start, b.id`)
    .bind(sessionId).all<DerivativeInventoryRow>();
  const derivativeJobQuery = db.prepare(`SELECT DISTINCT j.id, j.source_binary_object_id,
      j.profile_version, j.status, j.renderer, j.renderer_version, j.renderer_image_digest,
      j.page_count, j.segment_count, j.completed_at
    FROM promotion_jobs p INNER JOIN derivative_jobs j ON j.document_id = p.document_id
    WHERE p.upload_session_id = ? ORDER BY j.created_at, j.id`)
    .bind(sessionId).all<DerivativeJobRow>();
  const accessAuditQuery = db.prepare(`SELECT DISTINCT a.event_number, a.action,
      a.details_json, a.created_at
    FROM promotion_jobs p INNER JOIN audit_events a ON a.document_id = p.document_id
    WHERE p.upload_session_id = ? AND a.action IN
      ('document.ticket-issued', 'document.viewed', 'document.access-denied')
    ORDER BY a.event_number`).bind(sessionId).all<AccessAuditRow>();
  const keyMigrationQuery = db.prepare(
    "SELECT status, COUNT(*) AS count FROM legacy_key_migrations GROUP BY status").all<KeyMigrationCountRow>();
  const [receiptResult, eventResult, counts, originals, derivatives, derivativeJobs, accessAudit, keyMigrations] = await Promise.all([
    receiptQuery, eventQuery, countQuery, originalQuery, derivativeQuery, derivativeJobQuery, accessAuditQuery, keyMigrationQuery,
  ]);

  const receipt = preferredReceipt(session.status, receiptResult.results ?? []);
  return {
    contractVersion: 1,
    sessionId: session.id,
    terminalStatus: session.status,
    decisionCode: decisionCode(session.status, receipt),
    duplicateOfDocumentId: session.duplicate_of_document_id,
    receipt: safeReceipt(receipt),
    transitionChain: await verifyEventChain(session, eventResult.results ?? []),
    counts: {
      documents: Number(counts?.document_count ?? 0),
      originalObjects: Number(counts?.original_count ?? 0),
      ocrJobs: Number(counts?.ocr_job_count ?? 0),
      verifiedPromotions: Number(counts?.verified_promotion_count ?? 0),
    },
    originalInventory: (originals.results ?? []).map((object) => ({
      id: object.id,
      sha256: object.sha256,
      byteSize: Number(object.byte_size),
      storageVersionId: object.storage_version_id,
    })),
    derivativeInventory: (derivatives.results ?? []).map((object) => ({
      id: object.id,
      sha256: object.sha256,
      byteSize: Number(object.byte_size),
      mediaType: object.media_type,
      derivedFromId: object.derived_from_id,
      generator: object.generator,
      generationId: object.derivative_generation_id,
      pageStart: object.page_start === null ? null : Number(object.page_start),
      pageEnd: object.page_end === null ? null : Number(object.page_end),
    })),
    derivativeJobs: (derivativeJobs.results ?? []).map((job) => ({
      id: job.id,
      sourceBinaryObjectId: job.source_binary_object_id,
      profileVersion: job.profile_version,
      status: job.status,
      renderer: job.renderer,
      rendererVersion: job.renderer_version,
      rendererImageDigest: job.renderer_image_digest,
      pageCount: job.page_count === null ? null : Number(job.page_count),
      segmentCount: job.segment_count === null ? null : Number(job.segment_count),
      completedAt: job.completed_at,
    })),
    accessAudit: (accessAudit.results ?? []).map(safeAccessAudit),
    legacyKeyMigrations: {
      total: (keyMigrations.results ?? []).reduce((sum, row) => sum + Number(row.count), 0),
      byStatus: Object.fromEntries((keyMigrations.results ?? [])
        .map((row) => [row.status, Number(row.count)])),
    },
  };
}

/** Yaln?z staging kabul ko?usu i?in ikinci profil i?ini idempotent bi?imde kuyru?a al?r. */
export async function enqueueAcceptanceSecondDerivative(db: D1Database, sessionId: string) {
  if (!isSafeAcceptanceSessionId(sessionId)) throw new AcceptanceEvidenceNotFoundError();
  const document = await db.prepare(`SELECT p.document_id, p.binary_object_id
    FROM upload_sessions s INNER JOIN promotion_jobs p ON p.upload_session_id = s.id
    WHERE s.id = ? AND s.status = 'ACCEPTED' AND p.status = 'COMPLETED'
    LIMIT 1`).bind(sessionId).first<AcceptanceDocumentRow>();
  if (!document) throw new AcceptanceEvidenceNotFoundError();
  const now = new Date().toISOString();
  const result = await db.prepare(`INSERT OR IGNORE INTO derivative_jobs
      (id, document_id, source_binary_object_id, profile_version, status,
       attempt, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'QUEUED', 0, 5, ?, ?)`)
    .bind(crypto.randomUUID(), document.document_id, document.binary_object_id,
      ACCEPTANCE_SECOND_DERIVATIVE_PROFILE, now, now).run();
  return {
    documentId: document.document_id,
    sourceBinaryObjectId: document.binary_object_id,
    profileVersion: ACCEPTANCE_SECOND_DERIVATIVE_PROFILE,
    enqueued: Number(result.meta.changes ?? 0) === 1,
  };
}

/**
 * Yaln?z staging kabul y?neticisinin POST i?lemi i?in fiziksel nesne konumunu
 * ??zer. Bu de?er genel kan?t GET yan?t?na veya kal?c? kan?t dosyas?na girmez;
 * negatif IAM istemcisi ayn? s?re? belle?inde kullan?p yaln?z anahtar ?zetini
 * raporlar.
 */
export async function resolveAcceptancePrivateObjectLocator(
  db: D1Database,
  sessionId: string,
  objectClass: "original" | "quarantine",
) {
  if (!isSafeAcceptanceSessionId(sessionId)) throw new AcceptanceEvidenceNotFoundError();
  const sql = objectClass === "original"
    ? `SELECT b.object_key, b.sha256, b.byte_size, b.object_class
       FROM upload_sessions s
       INNER JOIN promotion_jobs p ON p.upload_session_id = s.id
       INNER JOIN binary_objects b ON b.id = p.binary_object_id
       WHERE s.id = ? AND s.status = 'ACCEPTED' AND p.status = 'COMPLETED'
         AND b.object_class = 'original' LIMIT 1`
    : `SELECT o.object_key, o.sha256, o.byte_size, o.object_class
       FROM upload_sessions s
       INNER JOIN ingest_objects o ON o.upload_session_id = s.id
       WHERE s.id = ? AND o.object_class = 'quarantine' AND o.deleted_at IS NULL
       LIMIT 1`;
  const row = await db.prepare(sql).bind(sessionId).first<PrivateObjectLocatorRow>();
  if (!row || row.object_class !== objectClass || !row.sha256) {
    throw new AcceptanceEvidenceNotFoundError();
  }
  return {
    objectKey: row.object_key,
    objectClass: row.object_class,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
  };
}

type PortableObjectLocationRow = {
  id: string;
  object_class: string;
  bucket_or_namespace: string;
  object_key: string;
  byte_size: number;
  sha256: string | null;
};

/**
 * T-09/T-10 — ACCEPTED oturumun belgesi için F1.10 taşınabilir manifestini ve
 * nesnelerin fiziksel konumlarını üretir. Manifest sağlayıcı alanı taşımaz;
 * konum listesi yalnız kabul koşusu belleğinde kullanılır, kanıt dosyasına ve
 * loglara fiziksel anahtar yazılmaz. Manifest özeti yanıtla birlikte döner;
 * koşucu özeti kendi tarafında yeniden hesaplayarak güven kökü edinir.
 */
export async function exportAcceptancePortableManifest(db: D1Database, sessionId: string) {
  if (!isSafeAcceptanceSessionId(sessionId)) throw new AcceptanceEvidenceNotFoundError();
  const document = await db.prepare(`SELECT p.document_id, p.binary_object_id
    FROM upload_sessions s INNER JOIN promotion_jobs p ON p.upload_session_id = s.id
    WHERE s.id = ? AND s.status = 'ACCEPTED' AND p.status = 'COMPLETED'
    LIMIT 1`).bind(sessionId).first<AcceptanceDocumentRow>();
  if (!document) throw new AcceptanceEvidenceNotFoundError();

  const manifest = await buildPortableManifest(db, document.document_id);
  validatePortableManifest(manifest);
  if (!await verifyAuditChain(manifest.document.id, manifest.auditChain)) {
    throw new Error("Kaynak denetim zinciri kriptografik doğrulamadan geçmedi.");
  }
  const digest = await manifestDigest(manifest);

  const locations = await db.prepare(`SELECT id, object_class, bucket_or_namespace,
      object_key, byte_size, sha256 FROM binary_objects
    WHERE document_id = ? AND retention_status <> 'DISPOSED' ORDER BY id`)
    .bind(document.document_id).all<PortableObjectLocationRow>();
  const locationById = new Map((locations.results ?? []).map((row) => [row.id, row]));
  const objectLocators = manifest.objects.map((object) => {
    const row = locationById.get(object.id);
    if (!row?.sha256 || row.sha256 !== object.sha256
      || Number(row.byte_size) !== object.byteSize) {
      throw new Error("Paket nesnesinin depolama kaydı manifest kanıtıyla uyuşmuyor.");
    }
    return {
      id: object.id,
      objectClass: object.objectClass,
      namespace: row.bucket_or_namespace,
      objectKey: row.object_key,
      byteSize: object.byteSize,
      sha256: object.sha256,
    };
  });

  return {
    documentId: document.document_id,
    manifest,
    manifestDigest: digest,
    objectLocators,
  };
}

export async function secureAcceptanceTokenEqual(provided: string, configured: string) {
  const encoder = new TextEncoder();
  const [providedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  const left = new Uint8Array(providedDigest);
  const right = new Uint8Array(configuredDigest);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export async function acceptanceEvidenceAccessDecision(input: {
  appEnv?: string;
  configuredToken?: string;
  authorization?: string | null;
}) {
  if (input.appEnv !== "staging") {
    return { status: 404, message: "Kaynak bulunamad?." };
  }
  const configuredToken = input.configuredToken?.trim() ?? "";
  if (configuredToken.length < 32) {
    return { status: 503, message: "Kabul kan?t? u? noktas? yap?land?r?lmam??." };
  }
  const authorization = input.authorization ?? "";
  const providedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length) : "";
  if (!providedToken || !(await secureAcceptanceTokenEqual(providedToken, configuredToken))) {
    return { status: 401, message: "Ge?erli kabul kan?t? yetkisi gereklidir." };
  }
  return null;
}
