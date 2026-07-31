/**
 * K-3 — Multipart yükleme kesinti sonrası sürer.
 *
 * 32 MiB eşiğini aşan geçerli bir PDF üç parçaya bölünür. 1. parça doğrulanır;
 * 2. parça bozuk baytlarla "kesintiye uğrar" (sunucu 422 ile reddetmeli, parça
 * VERIFIED sayılmamalı). İstemci çökmesi, aynı idempotency anahtarıyla oturumun
 * yeniden açılmasıyla taklit edilir: sunucu `resumed` bayrağı ve korunmuş
 * `completedParts` envanteriyle dönmelidir. Kalan parçalar yüklenip tamamlanır;
 * terminal ACCEPTED ve sunucunun tam-akış SHA-256'sı yerel özetle eşleşmelidir.
 */

import { randomUUID } from "node:crypto";

import { completeAndPoll, fail, failureEvidence, partSlices, redact } from "./flows.mjs";
import { buildPdfFixture, sha256Hex } from "./fixtures.mjs";

const EVIDENCE_KINDS = ["multipart", "inventory"];
// 33 MiB dolgu → toplam ~34,6 MB: eşik (32 MiB) aşılır, 16 MiB'lık üç parça oluşur.
const DEFAULT_PADDING_BYTES = 33 * 1024 * 1024;

export async function runMultipartResume(client, ctx) {
  const correlationId = `${ctx.runId}:K-3`;
  const writeEvidence = ctx.writeEvidence;
  const unit = ctx.config.unit ?? "Yazı İşleri";
  const tag = `k3-${ctx.runId}-${randomUUID()}`;
  const idempotencyKey = tag;

  const bytes = buildPdfFixture({ text: tag, paddingBytes: ctx.paddingBytes ?? DEFAULT_PADDING_BYTES });
  const localSha256 = sha256Hex(bytes);
  const metadata = {
    unit,
    byteSize: bytes.byteLength,
    mediaType: "application/pdf",
    originalName: `${tag}.pdf`,
  };
  const failEvidence = (detail) => failureEvidence(writeEvidence, "K-3", EVIDENCE_KINDS, {
    correlationId,
    byteSize: bytes.byteLength,
    localSha256,
    ...detail,
  });

  const created = await client.json("POST", "/api/uploads", {
    headers: { "idempotency-key": idempotencyKey },
    body: metadata,
  });
  const session = created.body?.session;
  if (!created.ok || !session?.id) {
    return fail(correlationId, "K3_SESSION_NOT_CREATED",
      await failEvidence({ stage: "create", response: redact(created) }));
  }
  if (session.multipart !== true || !Number.isSafeInteger(session.partSize)
    || session.partSize < 1 || (session.expectedPartCount ?? 0) < 2) {
    return fail(correlationId, "K3_NOT_MULTIPART", await failEvidence({
      stage: "create",
      multipart: session.multipart ?? null,
      expectedPartCount: session.expectedPartCount ?? null,
    }));
  }
  const slices = partSlices(bytes, session.partSize);

  const firstPart = await client.putPart(`/api/uploads/${session.id}/parts`,
    { partNumber: 1, sha256: slices[0].sha256, bytes: slices[0].bytes });
  if (!firstPart.ok) {
    return fail(correlationId, "K3_PART_UPLOAD_FAILED",
      await failEvidence({ stage: "part-1", response: redact(firstPart) }));
  }

  // Kesinti: 2. parçanın ilk baytı bozulur ama orijinal SHA beyan edilir.
  // Sunucu akış özetiyle beyanı karşılaştırıp yazmayı reddetmelidir.
  const corrupted = Uint8Array.from(slices[1].bytes);
  corrupted[0] ^= 0xff;
  const interrupted = await client.putPart(`/api/uploads/${session.id}/parts`,
    { partNumber: 2, sha256: slices[1].sha256, bytes: corrupted });
  if (interrupted.ok) {
    return fail(correlationId, "K3_CORRUPTION_NOT_DETECTED",
      await failEvidence({ stage: "interrupted-part", response: redact(interrupted) }));
  }

  // İstemci yeniden başlar: aynı idempotency anahtarı oturumu devralmalıdır.
  const resumed = await client.json("POST", "/api/uploads", {
    headers: { "idempotency-key": idempotencyKey },
    body: metadata,
  });
  const resumedSession = resumed.body?.session;
  const resumeIntact = resumed.ok
    && resumedSession?.id === session.id
    && resumedSession?.resumed === true
    && Array.isArray(resumedSession.completedParts) && resumedSession.completedParts.includes(1)
    && Array.isArray(resumedSession.missingParts) && resumedSession.missingParts.includes(2);
  if (!resumeIntact) {
    return fail(correlationId, "K3_RESUME_STATE_LOST", await failEvidence({
      stage: "resume",
      response: redact(resumed),
      resumed: resumedSession?.resumed ?? null,
      completedParts: resumedSession?.completedParts ?? null,
      missingParts: resumedSession?.missingParts ?? null,
    }));
  }

  for (const slice of slices.slice(1)) {
    const uploaded = await client.putPart(`/api/uploads/${session.id}/parts`,
      { partNumber: slice.partNumber, sha256: slice.sha256, bytes: slice.bytes });
    if (!uploaded.ok) {
      return fail(correlationId, "K3_PART_UPLOAD_FAILED",
        await failEvidence({ stage: `part-${slice.partNumber}`, response: redact(uploaded) }));
    }
  }

  const { completed, afterComplete, serverSha, poll } = await completeAndPoll(client, session.id, ctx, {
    timeoutMs: ctx.timeoutMs ?? 2.5 * 60_000,
  });
  if (!completed.ok) {
    return fail(correlationId, "K3_COMPLETE_REJECTED",
      await failEvidence({ stage: "complete", response: redact(completed) }));
  }

  const multipart = await writeEvidence("K-3-multipart", "multipart", {
    testId: "K-3",
    correlationId,
    sessionId: session.id,
    byteSize: bytes.byteLength,
    partSize: session.partSize,
    expectedPartCount: session.expectedPartCount,
    interruptedPartResponse: redact(interrupted),
    resume: {
      resumed: resumedSession.resumed,
      completedParts: resumedSession.completedParts,
      missingParts: resumedSession.missingParts,
    },
    completeStatus: afterComplete,
    observedStatuses: poll.observed,
    finalStatus: poll.status,
    timedOut: poll.timedOut,
  });
  const shaMatches = serverSha === localSha256;
  const inventory = await writeEvidence("K-3-inventory", "inventory", {
    testId: "K-3",
    correlationId,
    localSha256,
    serverSha256: serverSha,
    shaMatches,
    byteSize: bytes.byteLength,
    finalStatus: poll.status,
    assertion: "verified parts survive an interrupted attempt; the reassembled object hashes to the client-side digest",
  });
  const evidence = [multipart, inventory];

  if (poll.timedOut) {
    return { result: "FAIL", correlationId, errorCode: "K3_INCONCLUSIVE_TIMEOUT", evidence };
  }
  if (poll.status !== "ACCEPTED") {
    return { result: "FAIL", correlationId, errorCode: "K3_TERMINAL_NOT_ACCEPTED", evidence };
  }
  if (!shaMatches) {
    return { result: "FAIL", correlationId, errorCode: "K3_SHA_MISMATCH", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
