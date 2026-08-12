import type { StreamingHasher } from "./content-hasher.ts";
import { assertIngestSize } from "./ingest-contract.ts";
import { transitionIngestSession, type IngestActor } from "./ingest-events.ts";
import {
  ObjectStorageError,
  type StagingStorage,
  type UploadedPart,
} from "./object-storage.ts";
import type { IngestSessionStatus } from "./ingest-state-machine.ts";

export const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_CONCURRENT_PARTS = 4;
/** ADR-014: bir parça için verilen yazma yetkisi en çok 15 dakikadır. */
export const PART_SLOT_LEASE_MS = 15 * 60 * 1000;

type SessionRow = {
  id: string;
  user_id: string;
  unit: string;
  original_name: string;
  requested_document_type: string;
  idempotency_key: string;
  status: IngestSessionStatus;
  state_version: number;
  expected_byte_size: number;
  uploaded_byte_size: number;
  declared_media_type: string;
  provider_upload_token: string | null;
  expires_at: string;
};

type PartRow = {
  part_number: number;
  byte_size: number;
  checksum_sha256: string;
  provider_part_token: string;
  status: string;
};

export class IngestOperationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "IngestOperationError";
    this.code = code;
    this.status = status;
  }
}

export type IngestDependencies = {
  db: D1Database;
  temporary: StagingStorage;
  quarantine: StagingStorage;
  hasher: StreamingHasher;
  now?: () => Date;
  randomId?: () => string;
};

export type CreateUploadInput = {
  userId: string;
  unit: string;
  idempotencyKey: string;
  expectedByteSize: number;
  declaredMediaType: string;
  originalName?: string;
  requestedDocumentType?: string;
  tenantId?: string;
};

function clock(dependencies: IngestDependencies) {
  return dependencies.now?.() ?? new Date();
}

function randomId(dependencies: IngestDependencies) {
  return dependencies.randomId?.() ?? crypto.randomUUID();
}

export function expectedPartCount(byteSize: number) {
  return byteSize > MULTIPART_THRESHOLD_BYTES ? Math.ceil(byteSize / MULTIPART_PART_BYTES) : 1;
}

export function expectedPartSize(total: number, partNumber: number) {
  const count = expectedPartCount(total);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new IngestOperationError("INVALID_PART_NUMBER", `Parça numarası 1 ile ${count} arasında olmalıdır.`);
  }
  if (count === 1) return total;
  return partNumber === count ? total - MULTIPART_PART_BYTES * (count - 1) : MULTIPART_PART_BYTES;
}

function temporaryKey(sessionId: string) {
  return `temporary/${sessionId}/payload`;
}

function quarantineKey(sessionId: string) {
  return `quarantine/${sessionId}/payload`;
}

function publicSession(row: SessionRow, parts: PartRow[] = []) {
  const expected = expectedPartCount(row.expected_byte_size);
  const verified = new Set(parts.filter((part) => part.status === "VERIFIED").map((part) => part.part_number));
  return {
    id: row.id,
    unit: row.unit,
    status: row.status,
    stateVersion: row.state_version,
    expectedByteSize: row.expected_byte_size,
    uploadedByteSize: parts.filter((part) => part.status === "VERIFIED").reduce((sum, part) => sum + part.byte_size, 0),
    declaredMediaType: row.declared_media_type,
    expiresAt: row.expires_at,
    multipart: row.expected_byte_size > MULTIPART_THRESHOLD_BYTES,
    partSize: MULTIPART_PART_BYTES,
    expectedPartCount: expected,
    completedParts: [...verified].sort((left, right) => left - right),
    missingParts: Array.from({ length: expected }, (_, index) => index + 1).filter((part) => !verified.has(part)),
  };
}

async function loadOwnedSession(db: D1Database, sessionId: string, userId: string) {
  const row = await db.prepare(`SELECT id, user_id, unit, original_name, requested_document_type, idempotency_key, status, state_version,
      expected_byte_size, uploaded_byte_size, declared_media_type, provider_upload_token, expires_at
    FROM upload_sessions WHERE id = ?`).bind(sessionId).first<SessionRow>();
  if (!row) throw new IngestOperationError("SESSION_NOT_FOUND", "Yükleme oturumu bulunamadı.", 404);
  if (row.user_id !== userId) throw new IngestOperationError("SESSION_FORBIDDEN", "Bu yükleme oturumuna erişim yetkiniz yok.", 403);
  return row;
}

async function listParts(db: D1Database, sessionId: string) {
  const result = await db.prepare(`SELECT part_number, byte_size, checksum_sha256,
      provider_part_token, status FROM upload_parts WHERE upload_session_id = ? ORDER BY part_number`)
    .bind(sessionId).all<PartRow>();
  return result.results;
}

export async function getUploadSession(dependencies: IngestDependencies, sessionId: string, userId: string) {
  const row = await loadOwnedSession(dependencies.db, sessionId, userId);
  return publicSession(row, await listParts(dependencies.db, sessionId));
}

export async function createUploadSession(dependencies: IngestDependencies, input: CreateUploadInput) {
  assertIngestSize(input.expectedByteSize);
  const idempotencyKey = input.idempotencyKey.trim();
  const mediaType = input.declaredMediaType.trim().toLowerCase();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new IngestOperationError("INVALID_IDEMPOTENCY_KEY", "Geçerli bir idempotency anahtarı gereklidir.");
  }
  if (!mediaType || mediaType.length > 200) {
    throw new IngestOperationError("INVALID_MEDIA_TYPE", "Bildirilen dosya türü geçersiz.");
  }
  const originalName = (input.originalName ?? "belge").trim();
  const requestedDocumentType = (input.requestedDocumentType ?? "Tasnif bekliyor").trim();
  if (!originalName || originalName.length > 255 || !requestedDocumentType || requestedDocumentType.length > 200) {
    throw new IngestOperationError("INVALID_DOCUMENT_METADATA", "Belge adı veya talep edilen belge türü geçersiz.");
  }
  const tenantId = input.tenantId ?? "default";
  const existing = await dependencies.db.prepare(`SELECT id, user_id, unit, original_name, requested_document_type, idempotency_key, status, state_version,
      expected_byte_size, uploaded_byte_size, declared_media_type, provider_upload_token, expires_at
    FROM upload_sessions WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?`)
    .bind(tenantId, input.userId, idempotencyKey).first<SessionRow>();
  if (existing) {
    if (existing.expected_byte_size !== input.expectedByteSize || existing.declared_media_type !== mediaType
      || existing.unit !== input.unit || existing.original_name !== originalName
      || existing.requested_document_type !== requestedDocumentType) {
      throw new IngestOperationError("IDEMPOTENCY_CONFLICT", "Bu idempotency anahtarı farklı bir yükleme isteğinde kullanılmış.", 409);
    }
    if (existing.status === "CREATED") {
      await transitionIngestSession(dependencies.db, {
        sessionId: existing.id,
        to: "UPLOADING",
        actor: { kind: "user", id: input.userId },
        eventId: randomId(dependencies),
      });
      return { ...(await getUploadSession(dependencies, existing.id, input.userId)), resumed: true };
    }
    return { ...(publicSession(existing, await listParts(dependencies.db, existing.id))), resumed: true };
  }

  const id = randomId(dependencies);
  const key = temporaryKey(id);
  const multipart = input.expectedByteSize > MULTIPART_THRESHOLD_BYTES;
  const providerToken = multipart
    ? await dependencies.temporary.createMultipartUpload(key, {
        contentType: mediaType,
        customMetadata: { uploadSessionId: id, objectClass: "temporary" },
      })
    : null;
  const now = clock(dependencies);
  const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS).toISOString();
  let persisted = false;
  try {
    await dependencies.db.batch([
      dependencies.db.prepare(`INSERT INTO upload_sessions
        (id, tenant_id, user_id, unit, original_name, requested_document_type, idempotency_key, status, expected_byte_size,
         declared_media_type, provider_upload_token, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?)`)
        .bind(id, tenantId, input.userId, input.unit, originalName, requestedDocumentType, idempotencyKey,
          input.expectedByteSize, mediaType, providerToken, expiresAt, now.toISOString(), now.toISOString()),
      dependencies.db.prepare(`INSERT INTO ingest_objects
        (id, upload_session_id, object_class, object_key, storage_provider,
         bucket_or_namespace, media_type, byte_size, created_at)
        VALUES (?, ?, 'temporary', ?, 'r2', 'TEMPORARY_FILES', ?, 0, ?)`)
        .bind(randomId(dependencies), id, key, mediaType, now.toISOString()),
    ]);
    persisted = true;
    await transitionIngestSession(dependencies.db, {
      sessionId: id,
      to: "UPLOADING",
      actor: { kind: "user", id: input.userId },
      now: now.toISOString(),
      eventId: randomId(dependencies),
    });
  } catch (error) {
    if (providerToken && !persisted) {
      try { await dependencies.temporary.abortMultipartUpload(key, providerToken); } catch { /* uzlaştırma güvenlik ağıdır */ }
    }
    throw error;
  }
  return { ...(await getUploadSession(dependencies, id, input.userId)), resumed: false };
}

/**
 * Her aktif parça isteği kendi kira kimliğini taşır. Böylece çöken isteğin
 * süresi dolmuş kaydı temizlenebilir; eski bir `finally` yalnız kendi kirasını
 * siler ve daha yeni isteklerin sayacını azaltamaz.
 */
async function acquirePartSlot(dependencies: IngestDependencies, sessionId: string, partNumber: number) {
  const now = clock(dependencies);
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + PART_SLOT_LEASE_MS).toISOString();
  const leaseId = randomId(dependencies);
  const results = await dependencies.db.batch([
    dependencies.db.prepare(
      "DELETE FROM upload_part_leases WHERE upload_session_id = ? AND expires_at <= ?",
    ).bind(sessionId, nowIso),
    dependencies.db.prepare(`INSERT INTO upload_part_leases
        (id, upload_session_id, part_number, expires_at, created_at)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND status = 'UPLOADING')
        AND (SELECT COUNT(*) FROM upload_part_leases
          WHERE upload_session_id = ? AND expires_at > ?) < ?
      ON CONFLICT(upload_session_id, part_number) DO NOTHING`)
      .bind(leaseId, sessionId, partNumber, leaseUntil, nowIso,
        sessionId, sessionId, nowIso, MAX_CONCURRENT_PARTS),
    dependencies.db.prepare(`UPDATE upload_sessions SET
        in_flight_parts = (SELECT COUNT(*) FROM upload_part_leases
          WHERE upload_session_id = ? AND expires_at > ?),
        parts_lease_expires_at = (SELECT MAX(expires_at) FROM upload_part_leases
          WHERE upload_session_id = ? AND expires_at > ?),
        updated_at = ? WHERE id = ?`)
      .bind(sessionId, nowIso, sessionId, nowIso, nowIso, sessionId),
  ]);
  if (!results[1]?.meta.changes) {
    throw new IngestOperationError("PART_CONCURRENCY_LIMIT", "Aynı anda en fazla dört parça yüklenebilir veya aynı parça için canlı bir yazma kirası vardır.", 429);
  }
  return leaseId;
}

async function releasePartSlot(dependencies: IngestDependencies, sessionId: string, leaseId: string) {
  const nowIso = clock(dependencies).toISOString();
  await dependencies.db.batch([
    dependencies.db.prepare("DELETE FROM upload_part_leases WHERE id = ? AND upload_session_id = ?")
      .bind(leaseId, sessionId),
    dependencies.db.prepare(
      "DELETE FROM upload_part_leases WHERE upload_session_id = ? AND expires_at <= ?",
    ).bind(sessionId, nowIso),
    dependencies.db.prepare(`UPDATE upload_sessions SET
        in_flight_parts = (SELECT COUNT(*) FROM upload_part_leases
          WHERE upload_session_id = ? AND expires_at > ?),
        parts_lease_expires_at = (SELECT MAX(expires_at) FROM upload_part_leases
          WHERE upload_session_id = ? AND expires_at > ?),
        updated_at = ? WHERE id = ?`)
      .bind(sessionId, nowIso, sessionId, nowIso, nowIso, sessionId),
  ]);
}
export type UploadPartInput = {
  sessionId: string;
  userId: string;
  partNumber: number;
  byteSize: number;
  checksumSha256: string;
  body: ReadableStream<Uint8Array>;
};

export async function uploadPart(dependencies: IngestDependencies, input: UploadPartInput) {
  const session = await loadOwnedSession(dependencies.db, input.sessionId, input.userId);
  if (session.status !== "UPLOADING") {
    throw new IngestOperationError("SESSION_NOT_UPLOADING", "Oturum parça kabul etmiyor.", 409);
  }
  if (new Date(session.expires_at).getTime() <= clock(dependencies).getTime()) {
    throw new IngestOperationError("SESSION_EXPIRED", "Yükleme oturumunun süresi dolmuş.", 410);
  }
  const requiredSize = expectedPartSize(session.expected_byte_size, input.partNumber);
  if (input.byteSize !== requiredSize) {
    throw new IngestOperationError("PART_SIZE_MISMATCH", `Bu parçanın boyutu ${requiredSize} bayt olmalıdır.`);
  }
  const expectedHash = input.checksumSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new IngestOperationError("INVALID_PART_CHECKSUM", "Parça SHA-256 değeri 64 karakterli hex olmalıdır.");
  }

  const leaseId = await acquirePartSlot(dependencies, session.id, input.partNumber);
  try {
    const key = temporaryKey(session.id);
    const [storageStream, hashStream] = input.body.tee();
    let receipt: UploadedPart;
    const digestPromise = dependencies.hasher.sha256(hashStream);
    if (session.provider_upload_token) {
      [receipt] = await Promise.all([
        dependencies.temporary.uploadPart(key, session.provider_upload_token, input.partNumber, storageStream),
        digestPromise,
      ]);
    } else {
      const [stat] = await Promise.all([
        dependencies.temporary.put(key, storageStream, {
          contentType: session.declared_media_type,
          contentSha256Hex: expectedHash,
          customMetadata: { uploadSessionId: session.id, objectClass: "temporary" },
        }),
        digestPromise,
      ]);
      receipt = { partNumber: 1, token: stat.etag ?? `sha256:${expectedHash}` };
    }
    const digest = await digestPromise;
    if (digest.byteSize !== input.byteSize || digest.sha256Hex !== expectedHash) {
      throw new IngestOperationError("PART_CHECKSUM_MISMATCH", "Parça içeriği bildirilen SHA-256 ile eşleşmiyor.", 422);
    }
    await dependencies.db.prepare(`INSERT INTO upload_parts
      (id, upload_session_id, part_number, byte_size, checksum_sha256,
       provider_part_token, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'VERIFIED', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(upload_session_id, part_number) DO UPDATE SET
        byte_size = excluded.byte_size, checksum_sha256 = excluded.checksum_sha256,
        provider_part_token = excluded.provider_part_token, status = 'VERIFIED',
        attempt_count = upload_parts.attempt_count + 1, updated_at = CURRENT_TIMESTAMP`)
      .bind(randomId(dependencies), session.id, input.partNumber, input.byteSize, expectedHash, receipt.token).run();
    const state = await getUploadSession(dependencies, session.id, input.userId);
    await dependencies.db.prepare("UPDATE upload_sessions SET uploaded_byte_size = ? WHERE id = ?")
      .bind(state.uploadedByteSize, session.id).run();
    return state;
  } finally {
    await releasePartSlot(dependencies, session.id, leaseId);
  }
}

export async function completeUploadSession(
  dependencies: IngestDependencies,
  sessionId: string,
  userId: string,
) {
  const session = await loadOwnedSession(dependencies.db, sessionId, userId);
  if (session.status === "QUARANTINED") {
    try { await dependencies.temporary.delete(temporaryKey(session.id)); } catch { /* uzlaştırma işi görünür kılar */ }
    return await getUploadSession(dependencies, sessionId, userId);
  }
  if (session.status !== "UPLOADING") {
    throw new IngestOperationError("SESSION_NOT_COMPLETABLE", "Oturum tamamlanabilir durumda değil.", 409);
  }
  const parts = await listParts(dependencies.db, session.id);
  const count = expectedPartCount(session.expected_byte_size);
  if (parts.length !== count || parts.some((part, index) =>
    part.part_number !== index + 1 || part.status !== "VERIFIED"
      || part.byte_size !== expectedPartSize(session.expected_byte_size, part.part_number))) {
    throw new IngestOperationError("UPLOAD_INCOMPLETE", "Yüklemenin doğrulanmış parçaları eksik.", 409);
  }

  const tempKey = temporaryKey(session.id);
  let tempStat = await dependencies.temporary.head(tempKey);
  if (!tempStat && session.provider_upload_token) {
    tempStat = await dependencies.temporary.completeMultipartUpload(
      tempKey,
      session.provider_upload_token,
      parts.map((part) => ({ partNumber: part.part_number, token: part.provider_part_token })),
    );
  }
  if (!tempStat || tempStat.size !== session.expected_byte_size) {
    throw new IngestOperationError("COMPLETED_SIZE_MISMATCH", "Tamamlanan nesne beklenen boyutla eşleşmiyor.", 422);
  }

  const qKey = quarantineKey(session.id);
  let quarantineStat = await dependencies.quarantine.head(qKey);
  if (!quarantineStat) {
    const source = await dependencies.temporary.get(tempKey);
    if (!source) throw new IngestOperationError("TEMPORARY_OBJECT_MISSING", "Geçici yükleme nesnesi bulunamadı.", 409);
    quarantineStat = await dependencies.quarantine.put(qKey, source.body, {
      contentType: session.declared_media_type,
      customMetadata: { uploadSessionId: session.id, objectClass: "quarantine" },
    });
  }
  if (quarantineStat.size !== session.expected_byte_size) {
    throw new IngestOperationError("QUARANTINE_SIZE_MISMATCH", "Karantina nesnesi beklenen boyutla eşleşmiyor.", 422);
  }
  const quarantineBody = await dependencies.quarantine.get(qKey);
  if (!quarantineBody) throw new IngestOperationError("QUARANTINE_OBJECT_MISSING", "Karantina nesnesi okunamadı.", 409);
  const digest = await dependencies.hasher.sha256(quarantineBody.body);
  if (digest.byteSize !== session.expected_byte_size) {
    throw new IngestOperationError("QUARANTINE_SIZE_MISMATCH", "Karantina nesnesinin tam akışı doğrulanamadı.", 422);
  }

  await dependencies.db.batch([
    dependencies.db.prepare(`UPDATE ingest_objects SET deleted_at = CURRENT_TIMESTAMP
      WHERE upload_session_id = ? AND object_class = 'temporary' AND deleted_at IS NULL`).bind(session.id),
    dependencies.db.prepare(`INSERT INTO ingest_objects
      (id, upload_session_id, object_class, object_key, storage_provider, bucket_or_namespace,
       storage_version_id, provider_etag, media_type, byte_size, sha256)
      VALUES (?, ?, 'quarantine', ?, 'r2', 'QUARANTINE_FILES', ?, ?, ?, ?, ?)
      ON CONFLICT(object_key) DO UPDATE SET storage_version_id = excluded.storage_version_id,
        provider_etag = excluded.provider_etag, byte_size = excluded.byte_size,
        sha256 = excluded.sha256, deleted_at = NULL`)
      .bind(randomId(dependencies), session.id, qKey, quarantineStat.providerVersionId,
        quarantineStat.etag, session.declared_media_type, digest.byteSize, digest.sha256Hex),
  ]);
  await transitionIngestSession(dependencies.db, {
    sessionId: session.id,
    to: "QUARANTINED",
    actor: { kind: "service", id: "ingest-completer" },
    eventId: randomId(dependencies),
  });
  await dependencies.db.prepare(`INSERT OR IGNORE INTO content_scan_jobs
      (id, upload_session_id, status, attempt, max_attempts)
    VALUES (?, ?, 'QUEUED', 0, 5)`).bind(randomId(dependencies), session.id).run();
  await dependencies.temporary.delete(tempKey);
  return { ...(await getUploadSession(dependencies, session.id, userId)), sha256: digest.sha256Hex };
}

function storageUploadMissing(error: unknown) {
  return error instanceof ObjectStorageError && error.code === "UPLOAD_NOT_FOUND";
}

/**
 * Yalnız süresi dolmuş tamamlanmamış nesneleri temizler. Oturum ve olay satırları
 * denetim kanıtı olarak fiziksel silinmez; oturum EXPIRED durumunda tutulur.
 */
export async function expireIncompleteUploads(
  dependencies: IngestDependencies,
  limit = 25,
  actor: IngestActor = { kind: "service", id: "ingest-lifecycle" },
) {
  const now = clock(dependencies).toISOString();
  const rows = await dependencies.db.prepare(`SELECT id, user_id, unit, original_name, requested_document_type, idempotency_key, status, state_version,
      expected_byte_size, uploaded_byte_size, declared_media_type, provider_upload_token, expires_at
    FROM upload_sessions
    WHERE status IN ('CREATED', 'UPLOADING') AND expires_at <= ?
    ORDER BY expires_at LIMIT ?`).bind(now, limit).all<SessionRow>();
  let expired = 0;
  for (const session of rows.results) {
    const key = temporaryKey(session.id);
    if (session.provider_upload_token) {
      try {
        await dependencies.temporary.abortMultipartUpload(key, session.provider_upload_token);
      } catch (error) {
        if (!storageUploadMissing(error)) throw error;
      }
    }
    await dependencies.temporary.delete(key);
    await dependencies.db.prepare(`UPDATE ingest_objects SET deleted_at = ? WHERE upload_session_id = ?
      AND object_class = 'temporary' AND deleted_at IS NULL`).bind(now, session.id).run();
    await dependencies.db.batch([
      dependencies.db.prepare("DELETE FROM upload_part_leases WHERE upload_session_id = ?").bind(session.id),
      dependencies.db.prepare(
        "UPDATE upload_sessions SET in_flight_parts = 0, parts_lease_expires_at = NULL WHERE id = ?",
      ).bind(session.id),
    ]);
    await transitionIngestSession(dependencies.db, {
      sessionId: session.id,
      to: "EXPIRED",
      actor,
      reason: "24 saatlik tamamlanmamış yükleme süresi doldu",
      now,
      eventId: randomId(dependencies),
    });
    expired += 1;
  }
  return { expired };
}
