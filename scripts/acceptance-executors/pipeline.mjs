/**
 * F1.11 — Kabul hattı canlı yürütücüleri (K-1…).
 *
 * Her yürütücü gerçek staging uygulamasını HTTP üzerinden sürer ve sonucu
 * fiziksel JSON kanıtla döndürür. Bu modül `ACCEPTANCE_EXECUTOR_MODULE` ile
 * yalnız scripts/acceptance-executors altından yüklenir.
 */

import { createHash, randomUUID } from "node:crypto";

import {
  ExecutorConfigError,
  createAppClient,
  evidenceWriter,
  pollUploadStatus,
} from "./contract.mjs";

const TERMINAL = ["ACCEPTED", "DUPLICATE", "REJECTED", "EXPIRED", "FAILED"];

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * K-1 — Bildirilen MIME (application/pdf) ile magic-byte uyuşmazlığı reddedilir.
 *
 * Zararsız bir yürütülebilir imzası (`MZ...`) PDF beyanıyla yüklenir. Tür/
 * magic-byte doğrulaması içeriği reddetmeli; oturum `REJECTED` terminaline
 * ulaşmalı ve asıl/OCR üretilmemelidir (kanıt rehberi K-1, test verisi
 * `mime-mismatch.exe`). İstemci enjekte edilebilir; birim testi sahte istemciyle
 * koşar.
 */
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
    return fail(correlationId, "K1_SESSION_NOT_CREATED", await evidenceForFailure(writeEvidence, { stage: "create", response: redact(created) }));
  }

  const part = await client.putPart(`/api/uploads/${sessionId}/parts`, { partNumber: 1, sha256, bytes: payload });
  if (!part.ok) {
    return fail(correlationId, "K1_PART_REJECTED_EARLY", await evidenceForFailure(writeEvidence, { stage: "part", response: redact(part) }));
  }

  const completed = await client.json("POST", `/api/uploads/${sessionId}/complete`, {});
  // Tamamlama tür reddiyle senkron da dönebilir; ikisini de kabul et.
  const afterComplete = completed.body?.session?.status ?? `HTTP_${completed.status}`;

  const poll = TERMINAL.includes(afterComplete)
    ? { status: afterComplete, observed: [afterComplete], timedOut: false }
    : await pollUploadStatus(client, sessionId, {
        terminal: TERMINAL,
        timeoutMs: ctx.timeoutMs ?? 4 * 60_000,
        intervalMs: ctx.intervalMs ?? 5_000,
        signal: ctx.signal,
        now: ctx.now,
      });

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

function redact(response) {
  return { status: response.status, ok: response.ok, code: response.body?.code ?? null };
}

async function evidenceForFailure(writeEvidence, detail) {
  const validation = await writeEvidence("K-1-validation", "validation", { testId: "K-1", ...detail });
  const absence = await writeEvidence("K-1-absence", "absence", { testId: "K-1", assertion: "upload did not reach acceptance", ...detail });
  return [validation, absence];
}

function fail(correlationId, errorCode, evidence) {
  return { result: "FAIL", correlationId, errorCode, evidence };
}

export const executors = {
  "K-1": async (input) => {
    const client = createAppClient({
      baseUrl: input.config.baseUrl,
      identity: input.config.uploaderIdentity,
      signal: input.signal,
    });
    return runMimeMismatch(client, {
      runId: input.runId,
      config: input.config,
      signal: input.signal,
      writeEvidence: evidenceWriter(input.evidenceDir),
    });
  },
};

export { ExecutorConfigError };
