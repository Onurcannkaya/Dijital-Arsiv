/**
 * F1.7 / ADR-015 — fail-closed PDF erişim türevi orkestrasyonu.
 *
 * Belge baytları Worker üzerinden taşınmaz. İzole renderer aslı salt-okunur
 * kimlikle okur, türev alanına koşullu yazar; Worker ise her segmenti bağımsız
 * rolden akışla okuyup doğrular ve yalnız eksiksiz üretim kuşağını etkinleştirir.
 */

import { prepareAuditEvent } from "./audit.ts";
import type { ObjectReader } from "./object-storage.ts";
import type { StreamingHasher } from "./content-hasher.ts";
import { logEvent } from "./observability.ts";

export const ACTIVE_DERIVATIVE_PROFILE = "access-pdf-v1";
export const EXPECTED_DERIVATIVE_RENDERER = "pdfium";
export const DERIVATIVE_RENDER_LEASE_MS = 30 * 60 * 1000;
export const DERIVATIVE_RENDER_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_DERIVATIVE_PAGES = 2_000;
export const MAX_DERIVATIVE_SEGMENT_BYTES = 512 * 1024 * 1024;
// D1 sonlandırma batch'i segment kayıtları + audit + iş güncellemesi taşır.
export const MAX_DERIVATIVE_SEGMENTS = 90;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

type DerivativeJob = {
  id: string;
  document_id: string;
  source_binary_object_id: string;
  profile_version: string;
  attempt: number;
  max_attempts: number;
  lease_token: string;
};

type JobContext = DerivativeJob & {
  source_object_key: string;
  source_byte_size: number;
  source_sha256: string;
};

export type RenderedSegment = {
  objectKey: string;
  pageStart: number;
  pageEnd: number;
  byteSize: number;
  sha256: string;
};

export type RenderResult = {
  renderId: string;
  renderer: string;
  rendererVersion: string;
  rendererImageDigest: string;
  profileVersion: string;
  pageCount: number;
  segments: RenderedSegment[];
};

export type DocumentRenderDependencies = {
  db: D1Database;
  derivativeReader: ObjectReader;
  hasher: StreamingHasher;
  serviceUrl: string;
  serviceToken: string;
  /** Dağıtımın izin verdiği, registry tarafından verilen değişmez imaj özeti. */
  expectedImageDigest: string;
  now?: () => Date;
  randomId?: () => string;
  fetcher?: typeof fetch;
};

function clock(dependencies: DocumentRenderDependencies) {
  return dependencies.now?.() ?? new Date();
}

function randomId(dependencies: DocumentRenderDependencies) {
  return dependencies.randomId?.() ?? crypto.randomUUID();
}

function parseRenderResult(value: unknown, context: JobContext, expectedImageDigest: string): RenderResult {
  if (!value || typeof value !== "object") throw new Error("Render servisi geçersiz yanıt verdi.");
  const row = value as Record<string, unknown>;
  const segments = Array.isArray(row.segments) ? row.segments.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Render bölüm kanıtı nesne değil.");
    const segment = entry as Record<string, unknown>;
    return {
      objectKey: String(segment.objectKey ?? ""),
      pageStart: Number(segment.pageStart),
      pageEnd: Number(segment.pageEnd),
      byteSize: Number(segment.byteSize),
      sha256: String(segment.sha256 ?? "").toLowerCase(),
    };
  }) : [];
  const result: RenderResult = {
    renderId: String(row.renderId ?? ""),
    renderer: String(row.renderer ?? ""),
    rendererVersion: String(row.rendererVersion ?? ""),
    rendererImageDigest: String(row.rendererImageDigest ?? "").toLowerCase(),
    profileVersion: String(row.profileVersion ?? ""),
    pageCount: Number(row.pageCount),
    segments,
  };
  if (result.renderId !== context.id
    || result.renderer !== EXPECTED_DERIVATIVE_RENDERER
    || !result.rendererVersion || result.rendererVersion === "unknown"
    || result.rendererImageDigest !== expectedImageDigest
    || result.profileVersion !== context.profile_version
    || !Number.isSafeInteger(result.pageCount) || result.pageCount < 1
    || result.pageCount > MAX_DERIVATIVE_PAGES
    || !segments.length || segments.length > MAX_DERIVATIVE_SEGMENTS) {
    throw new Error("Render servisi beklenen kimlik, profil veya kanıt sözleşmesini karşılamıyor.");
  }
  const keys = new Set<string>();
  let expectedStart = 1;
  for (const [index, segment] of segments.entries()) {
    const expectedKey = `derivatives/${context.document_id}/access/${context.id}/part-${String(index + 1).padStart(4, "0")}.pdf`;
    if (segment.objectKey !== expectedKey || keys.has(segment.objectKey)
      || !/^[a-f0-9]{64}$/.test(segment.sha256)
      || !Number.isSafeInteger(segment.byteSize) || segment.byteSize < 1
      || segment.byteSize > MAX_DERIVATIVE_SEGMENT_BYTES
      || !Number.isSafeInteger(segment.pageStart) || !Number.isSafeInteger(segment.pageEnd)
      || segment.pageStart !== expectedStart || segment.pageEnd < segment.pageStart) {
      throw new Error("Render bölüm kanıtı geçersiz, yinelenmiş veya sayfa aralığı bitişik değil.");
    }
    keys.add(segment.objectKey);
    expectedStart = segment.pageEnd + 1;
  }
  if (expectedStart !== result.pageCount + 1) {
    throw new Error("Render bölümleri belge sayfalarının tamamını kapsamıyor.");
  }
  return result;
}

/** Her profil belge başına bir kez kuyruğa girer; yeni profil eski kanıtı ezmez. */
async function ensurePendingJob(dependencies: DocumentRenderDependencies) {
  const pending = await dependencies.db.prepare(`SELECT d.id AS document_id, o.id AS source_id
    FROM archive_documents d
    INNER JOIN binary_objects o ON o.document_id = d.id AND o.object_class = 'original'
    WHERE o.media_type = 'application/pdf' AND o.retention_status <> 'DISPOSED'
      AND NOT EXISTS (SELECT 1 FROM derivative_jobs j
        WHERE j.document_id = d.id AND j.profile_version = ?)
    ORDER BY d.created_at LIMIT 1`)
    .bind(ACTIVE_DERIVATIVE_PROFILE)
    .first<{ document_id: string; source_id: string }>();
  if (!pending) return;
  const nowIso = clock(dependencies).toISOString();
  await dependencies.db.prepare(`INSERT OR IGNORE INTO derivative_jobs
      (id, document_id, source_binary_object_id, profile_version, status, attempt, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'QUEUED', 0, 5, ?, ?)`)
    .bind(randomId(dependencies), pending.document_id, pending.source_id,
      ACTIVE_DERIVATIVE_PROFILE, nowIso, nowIso).run();
}

async function claimJob(dependencies: DocumentRenderDependencies) {
  await ensurePendingJob(dependencies);
  const now = clock(dependencies);
  const nowIso = now.toISOString();
  const leaseToken = randomId(dependencies);
  const leaseUntil = new Date(now.getTime() + DERIVATIVE_RENDER_LEASE_MS).toISOString();
  return dependencies.db.prepare(`UPDATE derivative_jobs SET
      status = 'RENDERING', attempt = attempt + 1, lease_token = ?,
      lease_expires_at = ?, last_error = NULL, updated_at = ?
    WHERE id = (
      SELECT j.id FROM derivative_jobs j
      WHERE j.attempt < j.max_attempts
        AND (
          (j.status IN ('QUEUED', 'RETRY') AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?))
          OR (j.status = 'RENDERING' AND j.lease_expires_at <= ?)
        )
      ORDER BY j.created_at LIMIT 1
    )
    RETURNING id, document_id, source_binary_object_id, profile_version,
      attempt, max_attempts, lease_token`)
    .bind(leaseToken, leaseUntil, nowIso, nowIso, nowIso).first<DerivativeJob>();
}

async function loadContext(db: D1Database, jobId: string) {
  return db.prepare(`SELECT j.id, j.document_id, j.source_binary_object_id,
      j.profile_version, j.attempt, j.max_attempts, j.lease_token,
      o.object_key AS source_object_key, o.byte_size AS source_byte_size,
      o.sha256 AS source_sha256
    FROM derivative_jobs j
    INNER JOIN binary_objects o ON o.id = j.source_binary_object_id
      AND o.document_id = j.document_id AND o.object_class = 'original'
      AND o.media_type = 'application/pdf' AND o.retention_status <> 'DISPOSED'
    WHERE j.id = ?`).bind(jobId).first<JobContext>();
}

async function stillOwnsLease(db: D1Database, job: DerivativeJob) {
  const row = await db.prepare(`SELECT 1 AS ok FROM derivative_jobs
    WHERE id = ? AND status = 'RENDERING' AND lease_token = ?`)
    .bind(job.id, job.lease_token).first();
  return Boolean(row);
}

async function renewLease(dependencies: DocumentRenderDependencies, job: DerivativeJob) {
  const now = clock(dependencies);
  const result = await dependencies.db.prepare(`UPDATE derivative_jobs
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'RENDERING' AND lease_token = ?`)
    .bind(new Date(now.getTime() + DERIVATIVE_RENDER_LEASE_MS).toISOString(),
      now.toISOString(), job.id, job.lease_token).run();
  if (!result.meta.changes) throw new Error("Türev üretim kirası kaybedildi.");
}

/** Her bölüm tam okunur; tür, boyut ve SHA kanıtı sağlayıcı yanıtından bağımsızdır. */
async function verifySegments(
  dependencies: DocumentRenderDependencies,
  context: JobContext,
  segments: RenderedSegment[],
) {
  for (const segment of segments) {
    await renewLease(dependencies, context);
    const object = await dependencies.derivativeReader.get(segment.objectKey);
    if (!object || object.range !== null || object.contentType !== "application/pdf") {
      throw new Error(`Türev bölümü tam PDF olarak okunamadı: ${segment.pageStart}-${segment.pageEnd}`);
    }
    const digest = await dependencies.hasher.sha256(object.body);
    if (object.size !== segment.byteSize
      || digest.byteSize !== segment.byteSize || digest.sha256Hex !== segment.sha256) {
      throw new Error("Türev bölümünün yazma sonrası tam SHA-256 doğrulaması başarısız.");
    }
  }
  await renewLease(dependencies, context);
}

async function readServiceFailure(response: Response) {
  const body = (await response.text()).slice(0, 1000);
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const detail = parsed.detail;
    if (detail && typeof detail === "object") {
      const row = detail as Record<string, unknown>;
      return { message: String(row.message ?? body), reviewRequired: row.code === "REVIEW_REQUIRED" };
    }
    return { message: typeof detail === "string" ? detail : body, reviewRequired: /REVIEW_REQUIRED/.test(body) };
  } catch {
    return { message: body, reviewRequired: /REVIEW_REQUIRED/.test(body) };
  }
}

async function finalize(
  dependencies: DocumentRenderDependencies,
  context: JobContext,
  result: RenderResult,
) {
  const nowIso = clock(dependencies).toISOString();
  const generator = `${result.renderer}:${result.rendererVersion}:${result.profileVersion}`;
  const audit = await prepareAuditEvent(dependencies.db, {
    documentId: context.document_id,
    actor: "system:document-render",
    action: "document.derivative-created",
    details: {
      generationId: context.id,
      sourceBinaryObjectId: context.source_binary_object_id,
      sourceSha256: context.source_sha256,
      generator,
      rendererImageDigest: result.rendererImageDigest,
      pageCount: result.pageCount,
      segmentCount: result.segments.length,
      segmentShas: result.segments.map((segment) => segment.sha256),
    },
  });
  const statements = result.segments.map((segment) => dependencies.db.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, storage_provider, bucket_or_namespace,
       media_type, byte_size, sha256, derived_from_id, generator, page_start, page_end,
       derivative_generation_id, created_at)
    SELECT ?, ?, 'access', ?, 'r2', 'DERIVATIVE_FILES', 'application/pdf', ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM derivative_jobs
      WHERE id = ? AND status = 'RENDERING' AND lease_token = ?)`)
    .bind(randomId(dependencies), context.document_id, segment.objectKey, segment.byteSize,
      segment.sha256, context.source_binary_object_id, generator,
      segment.pageStart, segment.pageEnd, context.id, nowIso, context.id, context.lease_token));
  const results = await dependencies.db.batch([
    ...statements,
    audit.statement,
    dependencies.db.prepare(`UPDATE derivative_jobs SET status = 'COMPLETED', lease_token = NULL,
      lease_expires_at = NULL, next_attempt_at = NULL, failure_code = NULL, last_error = NULL,
      renderer = ?, renderer_version = ?, renderer_image_digest = ?, page_count = ?, segment_count = ?,
      completed_at = ?, updated_at = ? WHERE id = ? AND status = 'RENDERING' AND lease_token = ?`)
      .bind(result.renderer, result.rendererVersion, result.rendererImageDigest,
        result.pageCount, result.segments.length, nowIso, nowIso, context.id, context.lease_token),
  ]);
  if (!results.every((entry) => Boolean(entry.meta.changes))) {
    throw new Error("Türev sonlandırması kira çitine takıldı; kayıtlar yazılmadı.");
  }
  return {
    processed: true,
    result: "COMPLETED" as const,
    documentId: context.document_id,
    generationId: context.id,
    segments: result.segments.length,
  };
}

type FailureStatus = "RETRY" | "FAILED" | "REVIEW_REQUIRED";

async function recordFailure(
  dependencies: DocumentRenderDependencies,
  context: DerivativeJob,
  error: unknown,
  reviewRequired: boolean,
): Promise<FailureStatus | "STALE"> {
  const now = clock(dependencies);
  const terminal = reviewRequired || context.attempt >= context.max_attempts;
  const delay = Math.min(3600, 30 * (2 ** Math.max(0, context.attempt - 1)));
  const status: FailureStatus = reviewRequired ? "REVIEW_REQUIRED" : terminal ? "FAILED" : "RETRY";
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const update = await dependencies.db.prepare(`UPDATE derivative_jobs SET status = ?, next_attempt_at = ?,
      lease_token = NULL, lease_expires_at = NULL, failure_code = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'RENDERING' AND lease_token = ?`)
    .bind(status, terminal ? null : new Date(now.getTime() + delay * 1000).toISOString(),
      reviewRequired ? "REVIEW_REQUIRED" : "RENDER_FAILED", message,
      now.toISOString(), context.id, context.lease_token).run();
  if (!update.meta.changes) return "STALE";
  logEvent(reviewRequired ? "warn" : "error", "derivative.render-failed", {
    jobId: context.id,
    documentId: context.document_id,
    status,
    attempt: context.attempt,
  });
  return status;
}

async function failInvalidSource(dependencies: DocumentRenderDependencies, job: DerivativeJob) {
  return await recordFailure(
    dependencies,
    job,
    new Error("Türev işinin yetkili PDF asıl nesne kaydı bulunamadı."),
    false,
  );
}

export async function readDerivativeSummary(db: D1Database) {
  const jobs = await db.prepare(`SELECT
      SUM(CASE WHEN status IN ('QUEUED', 'RETRY', 'RENDERING') THEN 1 ELSE 0 END) AS depth,
      SUM(CASE WHEN status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END) AS review_required,
      SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS dead_letter
    FROM derivative_jobs`).first<Record<string, number>>();
  return {
    queueDepth: Number(jobs?.depth ?? 0),
    reviewRequired: Number(jobs?.review_required ?? 0),
    deadLetter: Number(jobs?.dead_letter ?? 0),
  };
}

export async function processNextDerivativeJob(dependencies: DocumentRenderDependencies) {
  const expectedImageDigest = dependencies.expectedImageDigest.trim().toLowerCase();
  if (!IMAGE_DIGEST_PATTERN.test(expectedImageDigest)) {
    throw new Error("DOCUMENT_RENDER_IMAGE_DIGEST sha256:<64-hex> biçiminde olmalıdır.");
  }
  const job = await claimJob(dependencies);
  if (!job) return { processed: false };
  const context = await loadContext(dependencies.db, job.id);
  if (!context) {
    const result = await failInvalidSource(dependencies, job);
    return { processed: true, result };
  }

  try {
    const response = await (dependencies.fetcher ?? fetch)(`${dependencies.serviceUrl.replace(/\/$/, "")}/v1/render`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${dependencies.serviceToken}`,
      },
      body: JSON.stringify({
        renderId: context.id,
        profileVersion: context.profile_version,
        expectedRendererImageDigest: expectedImageDigest,
        documentId: context.document_id,
        objectKey: context.source_object_key,
        byteSize: context.source_byte_size,
        sha256: context.source_sha256,
      }),
      signal: AbortSignal.timeout(DERIVATIVE_RENDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      const failure = await readServiceFailure(response);
      if (response.status === 422 && failure.reviewRequired) {
        const status = await recordFailure(dependencies, context, new Error(failure.message), true);
        return { processed: true, result: status };
      }
      throw new Error(`Render servisi ${response.status} hatası verdi: ${failure.message.slice(0, 300)}`);
    }
    const result = parseRenderResult(await response.json(), context, expectedImageDigest);
    await renewLease(dependencies, context);
    await verifySegments(dependencies, context, result.segments);
    if (!(await stillOwnsLease(dependencies.db, context))) return { processed: true, stale: true };
    return await finalize(dependencies, context, result);
  } catch (error) {
    const status = await recordFailure(dependencies, context, error, false);
    return { processed: true, result: status };
  }
}
