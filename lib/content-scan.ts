import { transitionIngestSession } from "./ingest-events.ts";

export const CONTENT_SCAN_LEASE_MS = 12 * 60 * 1000;
export const CONTENT_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

type ScanJob = {
  id: string;
  upload_session_id: string;
  attempt: number;
  max_attempts: number;
  lease_token: string;
};

type QuarantineObject = {
  object_key: string;
  byte_size: number;
  sha256: string;
  declared_media_type: string;
  original_name: string;
  status: "QUARANTINED" | "SCANNING";
};

export type ContentScanResult = {
  sha256: string;
  byteSize: number;
  detectedMediaType: string;
  typeValidationResult: "MATCH" | "MISMATCH" | "UNSUPPORTED";
  parserName: string;
  parserVersion: string;
  parserResult: "VALID" | "INVALID" | "ERROR";
  scannerEngine: string;
  scannerVersion: string;
  scannerSignatureVersion: string;
  scannerResult: "CLEAN" | "MALICIOUS" | "ERROR";
};

export type ContentScanDependencies = {
  db: D1Database;
  serviceUrl: string;
  serviceToken: string;
  now?: () => Date;
  randomId?: () => string;
  fetcher?: typeof fetch;
};

function clock(dependencies: ContentScanDependencies) {
  return dependencies.now?.() ?? new Date();
}

function randomId(dependencies: ContentScanDependencies) {
  return dependencies.randomId?.() ?? crypto.randomUUID();
}

function extensionOf(name: string) {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name.trim());
  return match ? `.${match[1].toLowerCase()}` : "";
}

function parseResult(value: unknown): ContentScanResult {
  if (!value || typeof value !== "object") throw new Error("Tarama servisi geçersiz yanıt verdi.");
  const row = value as Record<string, unknown>;
  const result = {
    sha256: String(row.sha256 ?? "").toLowerCase(),
    byteSize: Number(row.byteSize),
    detectedMediaType: String(row.detectedMediaType ?? ""),
    typeValidationResult: String(row.typeValidationResult ?? ""),
    parserName: String(row.parserName ?? ""),
    parserVersion: String(row.parserVersion ?? ""),
    parserResult: String(row.parserResult ?? ""),
    scannerEngine: String(row.scannerEngine ?? ""),
    scannerVersion: String(row.scannerVersion ?? ""),
    scannerSignatureVersion: String(row.scannerSignatureVersion ?? ""),
    scannerResult: String(row.scannerResult ?? ""),
  };
  if (!/^[a-f0-9]{64}$/.test(result.sha256)
    || !Number.isSafeInteger(result.byteSize) || result.byteSize < 1
    || !["MATCH", "MISMATCH", "UNSUPPORTED"].includes(result.typeValidationResult)
    || !["VALID", "INVALID", "ERROR"].includes(result.parserResult)
    || !["CLEAN", "MALICIOUS", "ERROR"].includes(result.scannerResult)
    || !result.detectedMediaType || !result.parserName || !result.parserVersion
    || !result.scannerEngine || !result.scannerVersion || !result.scannerSignatureVersion) {
    throw new Error("Tarama servisi kanıt sözleşmesini karşılamıyor.");
  }
  return result as ContentScanResult;
}

async function ensurePendingJob(dependencies: ContentScanDependencies) {
  await dependencies.db.prepare(`UPDATE content_scan_jobs SET status = 'COMPLETED',
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
    WHERE status <> 'COMPLETED' AND EXISTS (
      SELECT 1 FROM upload_sessions s WHERE s.id = content_scan_jobs.upload_session_id
        AND s.status IN ('VERIFIED', 'REJECTED')
    )`).bind(clock(dependencies).toISOString()).run();
  const pending = await dependencies.db.prepare(`SELECT s.id FROM upload_sessions s
    LEFT JOIN content_scan_jobs j ON j.upload_session_id = s.id
    WHERE s.status IN ('QUARANTINED', 'SCANNING') AND j.id IS NULL
    ORDER BY s.updated_at LIMIT 1`).first<{ id: string }>();
  if (!pending) return;
  await dependencies.db.prepare(`INSERT OR IGNORE INTO content_scan_jobs
      (id, upload_session_id, status, attempt, max_attempts)
    VALUES (?, ?, 'QUEUED', 0, 5)`).bind(randomId(dependencies), pending.id).run();
}

async function claimJob(dependencies: ContentScanDependencies) {
  await ensurePendingJob(dependencies);
  const now = clock(dependencies);
  const nowIso = now.toISOString();
  const leaseToken = randomId(dependencies);
  const leaseUntil = new Date(now.getTime() + CONTENT_SCAN_LEASE_MS).toISOString();
  return dependencies.db.prepare(`UPDATE content_scan_jobs SET
      status = 'SCANNING', attempt = attempt + 1, lease_token = ?,
      lease_expires_at = ?, last_error = NULL, updated_at = ?
    WHERE id = (
      SELECT j.id FROM content_scan_jobs j
      INNER JOIN upload_sessions s ON s.id = j.upload_session_id
      WHERE s.status IN ('QUARANTINED', 'SCANNING')
        AND j.attempt < j.max_attempts
        AND (
          (j.status IN ('QUEUED', 'RETRY') AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?))
          OR (j.status = 'SCANNING' AND j.lease_expires_at <= ?)
        )
      ORDER BY j.created_at LIMIT 1
    )
    RETURNING id, upload_session_id, attempt, max_attempts, lease_token`)
    .bind(leaseToken, leaseUntil, nowIso, nowIso, nowIso).first<ScanJob>();
}

async function loadObject(db: D1Database, sessionId: string) {
  return db.prepare(`SELECT o.object_key, o.byte_size, o.sha256,
      s.declared_media_type, s.original_name, s.status
    FROM upload_sessions s INNER JOIN ingest_objects o ON o.upload_session_id = s.id
    WHERE s.id = ? AND o.object_class = 'quarantine' AND o.deleted_at IS NULL`)
    .bind(sessionId).first<QuarantineObject>();
}

async function stillOwnsLease(db: D1Database, job: ScanJob) {
  const row = await db.prepare(`SELECT 1 AS ok FROM content_scan_jobs
    WHERE id = ? AND status = 'SCANNING' AND lease_token = ?`).bind(job.id, job.lease_token).first();
  return Boolean(row);
}

async function finalizeReceipt(
  dependencies: ContentScanDependencies,
  job: ScanJob,
  object: QuarantineObject,
  receiptId: string,
  result: "VERIFIED" | "REJECTED",
) {
  if (object.status === "QUARANTINED") {
    await transitionIngestSession(dependencies.db, {
      sessionId: job.upload_session_id,
      to: "SCANNING",
      actor: { kind: "service", id: "content-scan" },
      eventId: randomId(dependencies),
    });
  }
  await transitionIngestSession(dependencies.db, {
    sessionId: job.upload_session_id,
    to: result,
    actor: { kind: "service", id: "content-scan" },
    ingestReceiptId: receiptId,
    eventId: randomId(dependencies),
  });
  await dependencies.db.prepare(`UPDATE content_scan_jobs SET status = 'COMPLETED',
      lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
    WHERE id = ? AND lease_token = ?`)
    .bind(clock(dependencies).toISOString(), job.id, job.lease_token).run();
}

async function recoverReceipt(dependencies: ContentScanDependencies, job: ScanJob, object: QuarantineObject) {
  const receipt = await dependencies.db.prepare(`SELECT id, result FROM ingest_receipts
    WHERE upload_session_id = ? AND result IN ('VERIFIED', 'REJECTED')
    ORDER BY created_at DESC LIMIT 1`).bind(job.upload_session_id)
    .first<{ id: string; result: "VERIFIED" | "REJECTED" }>();
  if (!receipt) return null;
  const current = await dependencies.db.prepare("SELECT status FROM upload_sessions WHERE id = ?")
    .bind(job.upload_session_id)
    .first<{ status: QuarantineObject["status"] | "VERIFIED" | "REJECTED" }>();
  if (current?.status === "VERIFIED" || current?.status === "REJECTED") {
    await dependencies.db.prepare(`UPDATE content_scan_jobs SET status = 'COMPLETED',
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE id = ?`).bind(clock(dependencies).toISOString(), job.id).run();
    return receipt.result;
  }
  await finalizeReceipt(dependencies, job, { ...object, status: current?.status ?? object.status }, receipt.id, receipt.result);
  return receipt.result;
}

async function recordFailure(
  dependencies: ContentScanDependencies,
  job: ScanJob,
  object: QuarantineObject,
  error: unknown,
) {
  const now = clock(dependencies);
  const receiptId = randomId(dependencies);
  await dependencies.db.prepare(`INSERT INTO ingest_receipts
      (id, upload_session_id, result, sha256, byte_size, declared_media_type,
       detected_media_type, type_validation_result, parser_name, parser_version,
       parser_result, scanner_engine, scanner_version, scanner_signature_version,
       scanner_result, created_at)
    VALUES (?, ?, 'FAILED', ?, ?, ?, ?, 'UNSUPPORTED', 'unavailable', 'unknown',
      'ERROR', 'clamav', 'unknown', 'unknown', 'ERROR', ?)`)
    .bind(receiptId, job.upload_session_id, object.sha256, object.byte_size,
      object.declared_media_type, object.declared_media_type, now.toISOString()).run();
  const terminal = job.attempt >= job.max_attempts;
  const delay = Math.min(3600, 30 * (2 ** Math.max(0, job.attempt - 1)));
  const next = new Date(now.getTime() + delay * 1000).toISOString();
  await dependencies.db.prepare(`UPDATE content_scan_jobs SET status = ?,
      next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
      last_error = ?, updated_at = ? WHERE id = ? AND lease_token = ?`)
    .bind(terminal ? "FAILED" : "RETRY", terminal ? null : next,
      (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      now.toISOString(), job.id, job.lease_token).run();
}

export async function processNextContentScanJob(dependencies: ContentScanDependencies) {
  const job = await claimJob(dependencies);
  if (!job) return { processed: false };
  const object = await loadObject(dependencies.db, job.upload_session_id);
  if (!object?.sha256) throw new Error("Karantina nesnesi veya SHA-256 kanıtı bulunamadı.");
  const recovered = await recoverReceipt(dependencies, job, object);
  if (recovered) return { processed: true, result: recovered, recovered: true };
  try {
    const response = await (dependencies.fetcher ?? fetch)(`${dependencies.serviceUrl.replace(/\/$/, "")}/v1/scan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${dependencies.serviceToken}`,
      },
      body: JSON.stringify({
        sessionId: job.upload_session_id,
        objectKey: object.object_key,
        declaredMediaType: object.declared_media_type,
        fileExtension: extensionOf(object.original_name),
        byteSize: object.byte_size,
        sha256: object.sha256,
      }),
      signal: AbortSignal.timeout(CONTENT_SCAN_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`İçerik tarama servisi ${response.status} hatası verdi.`);
    const scan = parseResult(await response.json());
    if (scan.sha256 !== object.sha256 || scan.byteSize !== object.byte_size) {
      throw new Error("Tarama sonucu karantina boyut/SHA-256 kanıtıyla uyuşmuyor.");
    }
    if (!(await stillOwnsLease(dependencies.db, job))) return { processed: true, stale: true };
    const accepted = scan.typeValidationResult === "MATCH"
      && scan.parserResult === "VALID" && scan.scannerResult === "CLEAN";
    const receiptId = randomId(dependencies);
    await dependencies.db.prepare(`INSERT INTO ingest_receipts
        (id, upload_session_id, result, sha256, byte_size, declared_media_type,
         detected_media_type, type_validation_result, parser_name, parser_version,
         parser_result, scanner_engine, scanner_version, scanner_signature_version,
         scanner_result, verified_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(receiptId, job.upload_session_id, accepted ? "VERIFIED" : "REJECTED",
        scan.sha256, scan.byteSize, object.declared_media_type, scan.detectedMediaType,
        scan.typeValidationResult, scan.parserName, scan.parserVersion, scan.parserResult,
        scan.scannerEngine, scan.scannerVersion, scan.scannerSignatureVersion,
        scan.scannerResult, accepted ? clock(dependencies).toISOString() : null,
        clock(dependencies).toISOString()).run();
    await finalizeReceipt(dependencies, job, object, receiptId, accepted ? "VERIFIED" : "REJECTED");
    return { processed: true, result: accepted ? "VERIFIED" : "REJECTED" };
  } catch (error) {
    if (await stillOwnsLease(dependencies.db, job)) await recordFailure(dependencies, job, object, error);
    return { processed: true, result: "FAILED" as const };
  }
}

