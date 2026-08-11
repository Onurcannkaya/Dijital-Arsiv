/**
 * K-7 — Mükerrer SHA yeni belge/asıl/OCR üretmez.
 *
 * Koşuya özgü benzersiz içerik iki ayrı kabul oturumuyla yüklenir. İlk oturum
 * ACCEPTED terminaline ulaşır; ikinci oturum aynı sunucu SHA-256'sıyla
 * DUPLICATE terminaline gitmeli, PROMOTING/ACCEPTED hiç görmemelidir. Yokluk
 * kanıtı belge listesinden alınır: koşu etiketiyle aranan arşivde bu içerik
 * için tam olarak BİR belge kaydı bulunmalıdır.
 */

import { randomUUID } from "node:crypto";

import {
  driveSingleUpload, fail, failureEvidence, readAcceptanceEvidence, redact,
} from "./flows.mjs";
import { buildPdfFixture } from "./fixtures.mjs";

const EVIDENCE_KINDS = ["deduplication", "absence"];

function flowSummary(flow) {
  return {
    sessionId: flow.sessionId ?? null,
    sha256: flow.sha256,
    completeStatus: flow.afterComplete ?? null,
    serverSha256: flow.serverSha ?? null,
    observedStatuses: flow.poll?.observed ?? [],
    finalStatus: flow.poll?.status ?? null,
    timedOut: flow.poll?.timedOut ?? false,
    failed: flow.failed ?? null,
  };
}

export async function runDuplicateSha(client, ctx) {
  const correlationId = `${ctx.runId}:K-7`;
  const writeEvidence = ctx.writeEvidence;
  const unit = ctx.config.unit ?? "Yazı İşleri";
  const tag = `k7-${ctx.runId}-${randomUUID()}`;
  const originalName = `${tag}.pdf`;
  const bytes = buildPdfFixture({ text: tag });
  // İki terminal sırayla beklenir; yürütücünün 5 dakikalık toplam bütçesine sığmalı.
  const timeoutMs = ctx.timeoutMs ?? 2 * 60_000;

  const first = await driveSingleUpload(client, ctx, {
    unit, originalName, mediaType: "application/pdf", bytes,
    idempotencyKey: `${tag}-a`, timeoutMs,
  });
  if (first.failed) {
    return fail(correlationId, "K7_UPLOAD_FLOW_FAILED",
      await failureEvidence(writeEvidence, "K-7", EVIDENCE_KINDS, { correlationId, first: flowSummary(first) }));
  }
  if (first.poll.status !== "ACCEPTED") {
    return fail(correlationId,
      first.poll.timedOut ? "K7_INCONCLUSIVE_TIMEOUT" : "K7_FIRST_UPLOAD_NOT_ACCEPTED",
      await failureEvidence(writeEvidence, "K-7", EVIDENCE_KINDS, { correlationId, first: flowSummary(first) }));
  }

  const second = await driveSingleUpload(client, ctx, {
    unit, originalName, mediaType: "application/pdf", bytes,
    idempotencyKey: `${tag}-b`, timeoutMs,
  });
  if (second.failed) {
    return fail(correlationId, "K7_UPLOAD_FLOW_FAILED",
      await failureEvidence(writeEvidence, "K-7", EVIDENCE_KINDS, {
        correlationId, first: flowSummary(first), second: flowSummary(second),
      }));
  }
  const [firstEvidence, secondEvidence] = await Promise.all([
    readAcceptanceEvidence(client, ctx, first.sessionId),
    readAcceptanceEvidence(client, ctx, second.sessionId),
  ]);
  const firstDecision = firstEvidence.ok ? firstEvidence.body : null;
  const secondDecision = secondEvidence.ok ? secondEvidence.body : null;

  // Yokluk kanıtı: koşu etiketi benzersizdir; arşivde tek belge görünmelidir.
  const listed = await client.json("GET", `/api/documents?q=${encodeURIComponent(tag)}`);
  const matches = Array.isArray(listed.body?.documents)
    ? listed.body.documents.filter((document) => document.originalName === originalName)
    : null;

  const deduplication = await writeEvidence("K-7-deduplication", "deduplication", {
    testId: "K-7",
    correlationId,
    contentSha256: first.sha256,
    first: flowSummary(first),
    second: flowSummary(second),
    authoritative: {
      first: firstDecision ? {
        decisionCode: firstDecision.decisionCode,
        counts: firstDecision.counts,
      } : { response: redact(firstEvidence) },
      second: secondDecision ? {
        decisionCode: secondDecision.decisionCode,
        duplicateOfDocumentId: secondDecision.duplicateOfDocumentId,
      } : { response: redact(secondEvidence) },
    },
  });
  const absence = await writeEvidence("K-7-absence", "absence", {
    testId: "K-7",
    correlationId,
    documentListStatus: listed.status,
    matchingDocuments: matches === null ? null : matches.map((document) => ({
      sha256: document.sha256,
      byteSize: document.byteSize,
      unit: document.unit,
    })),
    secondReachedAccepted: second.poll.observed.includes("ACCEPTED"),
    secondReachedPromoting: second.poll.observed.includes("PROMOTING"),
    assertion: "a duplicate server-side SHA-256 terminates as DUPLICATE and creates no second document, original or OCR job",
    authoritativeCounts: secondDecision?.counts ?? null,
    authoritativeTransitions: secondDecision?.transitionChain?.events
      ?.map((event) => event.to) ?? null,
    authoritativeChainValid: secondDecision?.transitionChain?.valid ?? false,
  });
  const evidence = [deduplication, absence];

  if (second.poll.timedOut) {
    return { result: "FAIL", correlationId, errorCode: "K7_INCONCLUSIVE_TIMEOUT", evidence };
  }
  if (second.poll.status !== "DUPLICATE" || second.poll.observed.includes("ACCEPTED")) {
    return { result: "FAIL", correlationId, errorCode: "K7_DUPLICATE_NOT_DETECTED", evidence };
  }
  if (!listed.ok || matches === null) {
    return { result: "FAIL", correlationId, errorCode: "K7_DOCUMENT_LIST_UNAVAILABLE", evidence };
  }
  if (matches.length !== 1) {
    return {
      result: "FAIL",
      correlationId,
      errorCode: matches.length === 0 ? "K7_DOCUMENT_NOT_VISIBLE" : "K7_DOCUMENT_DUPLICATED",
      evidence,
    };
  }
  if (matches[0].sha256 !== first.sha256) {
    return { result: "FAIL", correlationId, errorCode: "K7_DOCUMENT_SHA_DIVERGED", evidence };
  }
  if (!firstEvidence.ok || !secondEvidence.ok) {
    return { result: "FAIL", correlationId, errorCode: "K7_EVIDENCE_UNAVAILABLE", evidence };
  }
  if (firstDecision.decisionCode !== "ACCEPTED_AND_VERIFIED"
      || firstDecision.transitionChain?.valid !== true
      || firstDecision.counts?.documents !== 1
      || firstDecision.counts?.originalObjects !== 1
      || firstDecision.counts?.ocrJobs !== 1
      || firstDecision.counts?.verifiedPromotions !== 1) {
    return { result: "FAIL", correlationId, errorCode: "K7_FIRST_EVIDENCE_INVALID", evidence };
  }
  const duplicateTransitions = secondDecision.transitionChain?.events
    ?.map((event) => event.to) ?? [];
  if (secondDecision.decisionCode !== "DUPLICATE"
      || secondDecision.transitionChain?.valid !== true
      || duplicateTransitions.includes("PROMOTING")
      || duplicateTransitions.includes("ACCEPTED")) {
    return { result: "FAIL", correlationId, errorCode: "K7_DUPLICATE_PATH_INVALID", evidence };
  }
  if (secondDecision.counts?.documents !== 0 || secondDecision.counts?.originalObjects !== 0
      || secondDecision.counts?.ocrJobs !== 0 || secondDecision.counts?.verifiedPromotions !== 0
      || secondDecision.duplicateOfDocumentId !== matches[0].id) {
    return { result: "FAIL", correlationId, errorCode: "K7_FORBIDDEN_ARTIFACT_CREATED", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
