/**
 * T-02 — Asıl SHA yazma sonrası doğrulanır.
 *
 * Zincir uçtan uca, uygulamanın dışından yeniden üretilir:
 *   yerel SHA-256 → tamamlama yanıtındaki karantina tam-akış SHA'sı →
 *   ACCEPTED sonrası belge kaydındaki SHA → DOWNLOAD biletiyle kasadan
 *   indirilen aslın yeniden hesaplanan SHA'sı.
 * Dört değer bayt-bayt eşleşmelidir. Bilet açık metni kanıta yazılmaz.
 */

import { randomUUID } from "node:crypto";

import { driveSingleUpload, fail, failureEvidence } from "./flows.mjs";
import { buildPdfFixture, sha256Hex } from "./fixtures.mjs";

const EVIDENCE_KINDS = ["receipt", "integrity"];

export async function runPostWriteShaVerification(client, ctx) {
  const correlationId = `${ctx.runId}:T-02`;
  const writeEvidence = ctx.writeEvidence;
  const unit = ctx.config.unit ?? "Yazı İşleri";
  const tag = `t02-${ctx.runId}-${randomUUID()}`;
  const originalName = `${tag}.pdf`;
  const bytes = buildPdfFixture({ text: tag });
  const failEvidence = (detail) => failureEvidence(writeEvidence, "T-02", EVIDENCE_KINDS, {
    correlationId,
    localSha256: sha256Hex(bytes),
    ...detail,
  });

  const flow = await driveSingleUpload(client, ctx, {
    unit, originalName, mediaType: "application/pdf", bytes,
    idempotencyKey: tag, timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  if (flow.failed) {
    return fail(correlationId, "T02_UPLOAD_FLOW_FAILED", await failEvidence({ flow: flow.failed }));
  }
  if (flow.poll.status !== "ACCEPTED") {
    return fail(correlationId,
      flow.poll.timedOut ? "T02_INCONCLUSIVE_TIMEOUT" : "T02_UPLOAD_NOT_ACCEPTED",
      await failEvidence({ observedStatuses: flow.poll.observed, finalStatus: flow.poll.status }));
  }
  if (flow.serverSha !== flow.sha256) {
    return fail(correlationId, "T02_QUARANTINE_SHA_MISMATCH",
      await failEvidence({ quarantineSha256: flow.serverSha }));
  }

  // ACCEPTED sonrası yetkili kayıt: belge listesi koşu etiketiyle aranır.
  const listed = await client.json("GET", `/api/documents?q=${encodeURIComponent(tag)}`);
  const document = Array.isArray(listed.body?.documents)
    ? listed.body.documents.find((entry) => entry.originalName === originalName)
    : null;
  if (!listed.ok || !document) {
    return fail(correlationId, "T02_DOCUMENT_NOT_FOUND",
      await failEvidence({ documentListStatus: listed.status }));
  }
  if (document.sha256 !== flow.sha256 || document.byteSize !== bytes.byteLength) {
    return fail(correlationId, "T02_RECORD_SHA_MISMATCH", await failEvidence({
      documentSha256: document.sha256,
      documentByteSize: document.byteSize,
    }));
  }

  const ticket = await client.json("POST", `/api/documents/${document.id}/access-ticket`, {
    body: { scope: "DOWNLOAD", purpose: "ORIGINAL_DOWNLOAD" },
  });
  const ticketToken = ticket.body?.ticket;
  if (!ticket.ok || typeof ticketToken !== "string") {
    return fail(correlationId, "T02_TICKET_DENIED",
      await failEvidence({ documentId: document.id, ticketStatus: ticket.status }));
  }

  const download = await client.getBytes(`/api/documents/${document.id}/file`, {
    headers: {
      authorization: `ArchiveTicket ${ticketToken}`,
      "x-archive-access-scope": "DOWNLOAD",
    },
  });
  if (!download.ok) {
    return fail(correlationId, "T02_DOWNLOAD_FAILED",
      await failEvidence({ documentId: document.id, downloadStatus: download.status }));
  }
  const downloadedSha256 = sha256Hex(download.bytes);

  const receipt = await writeEvidence("T-02-receipt", "receipt", {
    testId: "T-02",
    correlationId,
    sessionId: flow.sessionId,
    documentId: document.id,
    referenceNo: document.referenceNo ?? null,
    byteSize: bytes.byteLength,
    localSha256: flow.sha256,
    quarantineSha256: flow.serverSha,
    documentSha256: document.sha256,
    observedStatuses: flow.poll.observed,
    finalStatus: flow.poll.status,
  });
  const shaMatches = downloadedSha256 === flow.sha256
    && download.bytes.byteLength === bytes.byteLength;
  const integrity = await writeEvidence("T-02-integrity", "integrity", {
    testId: "T-02",
    correlationId,
    documentId: document.id,
    downloadedSha256,
    downloadedByteSize: download.bytes.byteLength,
    downloadedContentType: download.contentType ?? null,
    shaMatches,
    assertion: "the vault original re-read after promotion hashes byte-for-byte to the uploaded content",
  });
  const evidence = [receipt, integrity];

  if (!shaMatches) {
    return { result: "FAIL", correlationId, errorCode: "T02_VAULT_SHA_MISMATCH", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
