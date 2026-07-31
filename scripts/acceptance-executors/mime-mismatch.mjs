/**
 * K-1 — Bildirilen MIME (application/pdf) ile magic-byte uyuşmazlığı reddedilir.
 *
 * Zararsız bir yürütülebilir imzası (`MZ...`) PDF beyanıyla yüklenir. Tür/
 * magic-byte doğrulaması içeriği reddetmeli; oturum `REJECTED` terminaline
 * ulaşmalı ve asıl/OCR üretilmemelidir (kanıt rehberi K-1, test verisi
 * `mime-mismatch.exe`). İstemci enjekte edilebilir; birim testi sahte istemciyle
 * koşar.
 */

import { randomUUID } from "node:crypto";

import { completeAndPoll, fail, failureEvidence, redact } from "./flows.mjs";
import { sha256Hex } from "./fixtures.mjs";

export async function runMimeMismatch(client, ctx) {
  const correlationId = `${ctx.runId}:K-1`;
  const writeEvidence = ctx.writeEvidence;
  const unit = ctx.config.unit ?? "Yazı İşleri";

  // Zararsız PE/DOS yürütülebilir başlığı; gerçek zararlı yazılım kullanılmaz.
  const payload = new Uint8Array(64);
  payload[0] = 0x4d; // 'M'
  payload[1] = 0x5a; // 'Z'
  for (let index = 2; index < payload.length; index += 1) payload[index] = (index * 7) % 251;
  const sha256 = sha256Hex(payload);
  const idempotencyKey = `k1-${ctx.runId}-${randomUUID()}`;

  const created = await client.json("POST", "/api/uploads", {
    headers: { "idempotency-key": idempotencyKey },
    body: {
      unit,
      byteSize: payload.byteLength,
      mediaType: "application/pdf",
      originalName: "k1-mime-mismatch.pdf",
    },
  });
  const sessionId = created.body?.session?.id;
  if (!created.ok || !sessionId) {
    return fail(correlationId, "K1_SESSION_NOT_CREATED",
      await evidenceForFailure(writeEvidence, { stage: "create", response: redact(created) }));
  }

  const part = await client.putPart(`/api/uploads/${sessionId}/parts`, { partNumber: 1, sha256, bytes: payload });
  if (!part.ok) {
    return fail(correlationId, "K1_PART_REJECTED_EARLY",
      await evidenceForFailure(writeEvidence, { stage: "part", response: redact(part) }));
  }

  const { afterComplete, poll } = await completeAndPoll(client, sessionId, ctx);

  const validation = await writeEvidence("K-1-validation", "validation", {
    testId: "K-1",
    correlationId,
    declaredMediaType: "application/pdf",
    declaredExtension: ".pdf",
    payloadMagic: "MZ",
    sha256,
    byteSize: payload.byteLength,
    sessionId,
    completeStatus: afterComplete,
    observedStatuses: poll.observed,
    finalStatus: poll.status,
    timedOut: poll.timedOut,
  });
  const absence = await writeEvidence("K-1-absence", "absence", {
    testId: "K-1",
    correlationId,
    // REJECTED terminali terfiden önce gelir: asıl nesne ve OCR işi üretilmez.
    reachedAccepted: poll.observed.includes("ACCEPTED"),
    reachedDuplicate: poll.observed.includes("DUPLICATE"),
    finalStatus: poll.status,
    assertion: "no original or OCR job is created for a type-rejected upload",
  });

  if (poll.status === "REJECTED" && !poll.observed.includes("ACCEPTED")) {
    return { result: "PASS", correlationId, evidence: [validation, absence] };
  }
  if (poll.timedOut) {
    return { result: "FAIL", correlationId, errorCode: "K1_INCONCLUSIVE_TIMEOUT", evidence: [validation, absence] };
  }
  return { result: "FAIL", correlationId, errorCode: "K1_TYPE_MISMATCH_NOT_ENFORCED", evidence: [validation, absence] };
}

async function evidenceForFailure(writeEvidence, detail) {
  return failureEvidence(writeEvidence, "K-1", ["validation", "absence"], {
    assertion: "upload did not reach acceptance",
    ...detail,
  });
}
