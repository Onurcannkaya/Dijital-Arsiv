/**
 * F1.11 — Yürütücülerin paylaştığı yükleme akışı yardımcıları.
 *
 * Her yardımcı yalnız sözleşmedeki istemciyi (contract.mjs) sürer; kanıta
 * yazılacak HTTP yanıtları `redact` ile durum/kod düzeyine indirilir, gövde ve
 * başlıklar (bilet, oturum) asla kanıta taşınmaz.
 */

import { pollUploadStatus } from "./contract.mjs";
import { sha256Hex } from "./fixtures.mjs";

export const TERMINAL_STATUSES = ["ACCEPTED", "DUPLICATE", "REJECTED", "EXPIRED", "FAILED"];

export function redact(response) {
  return { status: response.status, ok: response.ok, code: response.body?.code ?? null };
}

export function fail(correlationId, errorCode, evidence) {
  return { result: "FAIL", correlationId, errorCode, evidence };
}

/**
 * Erken kesilen akışlarda bile manifest sözleşmesindeki her kanıt türünden bir
 * dosya üretir; koşu betiği PASS dışı sonuçlarda tür zorunluluğu aramaz ama
 * inceleyici hatanın hangi aşamada oluştuğunu fiziksel kanıttan okuyabilmelidir.
 */
export async function failureEvidence(writeEvidence, testId, kinds, detail) {
  const records = [];
  for (const kind of kinds) {
    records.push(await writeEvidence(`${testId}-${kind}`, kind, { testId, ...detail }));
  }
  return records;
}

/** Yükü sunucunun bildirdiği parça boyutuna göre dilimler; her dilim kendi SHA-256'sını taşır. */
export function partSlices(bytes, partSize) {
  if (!Number.isSafeInteger(partSize) || partSize < 1) {
    throw new Error("Parça boyutu pozitif tam sayı olmalıdır.");
  }
  const slices = [];
  for (let offset = 0; offset < bytes.byteLength; offset += partSize) {
    const slice = bytes.subarray(offset, Math.min(offset + partSize, bytes.byteLength));
    slices.push({ partNumber: slices.length + 1, bytes: slice, sha256: sha256Hex(slice) });
  }
  return slices;
}

export async function createSession(client, { unit, byteSize, mediaType, originalName, idempotencyKey }) {
  return client.json("POST", "/api/uploads", {
    headers: { "idempotency-key": idempotencyKey },
    body: { unit, byteSize, mediaType, originalName },
  });
}

/**
 * Tamamlama isteğini atar ve oturum terminale ulaşana kadar yoklar. Tamamlama
 * tarama reddiyle senkron terminal de dönebilir; ikisi de kabul edilir.
 */
export async function completeAndPoll(client, sessionId, ctx, { timeoutMs, intervalMs } = {}) {
  const completed = await client.json("POST", `/api/uploads/${sessionId}/complete`, {});
  const afterComplete = completed.body?.session?.status ?? `HTTP_${completed.status}`;
  const serverSha = completed.body?.session?.sha256 ?? null;
  const poll = TERMINAL_STATUSES.includes(afterComplete)
    ? { status: afterComplete, observed: [afterComplete], timedOut: false }
    : await pollUploadStatus(client, sessionId, {
        terminal: TERMINAL_STATUSES,
        timeoutMs: timeoutMs ?? ctx.timeoutMs ?? 4 * 60_000,
        intervalMs: intervalMs ?? ctx.intervalMs ?? 5_000,
        signal: ctx.signal,
        now: ctx.now,
      });
  return { completed, afterComplete, serverSha, poll };
}

/** Staging'e ?zel, maskeli kabul kan?t?n? ayr? en-dar yetki anahtar?yla okur. */
export async function readAcceptanceEvidence(client, ctx, sessionId) {
  const token = ctx.config.acceptanceToken ?? ctx.acceptanceToken;
  if (typeof token !== "string" || token.length < 32) {
    return {
      status: 0,
      ok: false,
      body: { code: "ACCEPTANCE_EVIDENCE_TOKEN_MISSING" },
    };
  }
  return client.json("GET", `/api/admin/acceptance-evidence/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
/** Fiziksel anahtar? yaln?z s?re? belle?ine alan staging-y?netici i?lemi. */
export async function resolvePrivateObjectLocator(client, ctx, sessionId, objectClass) {
  const token = ctx.config.acceptanceToken ?? ctx.acceptanceToken;
  if (typeof token !== "string" || token.length < 32) {
    return { status: 0, ok: false, body: { code: "ACCEPTANCE_EVIDENCE_TOKEN_MISSING" } };
  }
  return client.json("POST", `/api/admin/acceptance-evidence/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${token}` },
    body: { action: "RESOLVE_PRIVATE_OBJECT_LOCATOR", objectClass },
  });
}


/** Staging kabul ko?usuna ?zg? ikinci profil t?rev i?ini idempotent kuyru?a al?r. */
export async function enqueueAcceptanceSecondDerivative(client, ctx, sessionId) {
  const token = ctx.config.acceptanceToken ?? ctx.acceptanceToken;
  if (typeof token !== "string" || token.length < 32) {
    return { status: 0, ok: false, body: { code: "ACCEPTANCE_EVIDENCE_TOKEN_MISSING" } };
  }
  return client.json("POST", `/api/admin/acceptance-evidence/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${token}` },
    body: { action: "ENQUEUE_SECOND_DERIVATIVE_PROFILE" },
  });
}

/**
 * Tek parçalı tam akış: oturum aç → parçayı yükle → tamamla → terminali bekle.
 * Erken hata `failed.stage` ile döner; çağıran yürütücü kendi hata koduyla
 * FAIL üretir.
 */
export async function driveSingleUpload(client, ctx, {
  unit, originalName, mediaType, bytes, idempotencyKey, timeoutMs, intervalMs,
}) {
  const sha256 = sha256Hex(bytes);
  const created = await createSession(client, {
    unit, byteSize: bytes.byteLength, mediaType, originalName, idempotencyKey,
  });
  const sessionId = created.body?.session?.id;
  if (!created.ok || !sessionId) {
    return { sha256, failed: { stage: "create", response: redact(created) } };
  }
  const part = await client.putPart(`/api/uploads/${sessionId}/parts`, { partNumber: 1, sha256, bytes });
  if (!part.ok) {
    return { sha256, sessionId, failed: { stage: "part", response: redact(part) } };
  }
  const { completed, afterComplete, serverSha, poll } = await completeAndPoll(client, sessionId, ctx, { timeoutMs, intervalMs });
  if (!completed.ok && !TERMINAL_STATUSES.includes(afterComplete)) {
    return { sha256, sessionId, failed: { stage: "complete", response: redact(completed) } };
  }
  return { sha256, sessionId, afterComplete, serverSha, poll };
}
