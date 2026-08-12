/** T-05 ? VIEW bileti tek kullan?ml?, s?reli ve belge ba?lam?na s?k? ba?l?d?r. */

import { randomUUID } from "node:crypto";

import { sleep } from "./contract.mjs";
import {
  driveSingleUpload, fail, failureEvidence, readAcceptanceEvidence, redact,
} from "./flows.mjs";
import { buildPdfFixture } from "./fixtures.mjs";

const EVIDENCE_KINDS = ["access-denial", "audit"];

async function uploadDocument(client, ctx, tag) {
  const originalName = `${tag}.pdf`;
  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Yaz? ??leri",
    originalName,
    mediaType: "application/pdf",
    bytes: buildPdfFixture({ text: tag }),
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 4 * 60_000,
  });
  if (flow.failed || flow.poll.status !== "ACCEPTED") return { failed: flow };
  const listed = await client.json("GET", `/api/documents?q=${encodeURIComponent(tag)}`);
  const document = Array.isArray(listed.body?.documents)
    ? listed.body.documents.find((entry) => entry.originalName === originalName) : null;
  return !listed.ok || !document ? { failed: { listStatus: listed.status } }
    : { flow, document };
}

async function waitForViewTicket(client, ctx, documentId) {
  const deadline = Date.now() + (ctx.derivativeTimeoutMs ?? 6 * 60_000);
  const observed = [];
  for (;;) {
    const response = await client.json("POST", `/api/documents/${documentId}/access-ticket`, {
      body: { scope: "VIEW", purpose: "DOCUMENT_REVIEW" },
    });
    observed.push(response.status);
    if (response.ok && typeof response.body?.ticket === "string") return { response, observed };
    if (response.status !== 425 || Date.now() >= deadline) return { response, observed };
    await sleep(ctx.intervalMs ?? 5_000, ctx.signal);
  }
}

function denialDownload(status) {
  return status === 403;
}

export async function runExpiredViewTicket(client, ctx) {
  const correlationId = `${ctx.runId}:T-05`;
  const base = `t05-${ctx.runId}-${randomUUID()}`;
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-05", EVIDENCE_KINDS, {
    correlationId, ...detail,
  });

  const first = await uploadDocument(client, ctx, `${base}-a`);
  const second = await uploadDocument(client, ctx, `${base}-b`);
  if (first.failed || second.failed) {
    return fail(correlationId, "T05_FIXTURE_UPLOAD_FAILED", await failEvidence({
      first: first.failed ?? null, second: second.failed ?? null,
    }));
  }

  const issued = await waitForViewTicket(client, ctx, first.document.id);
  if (!issued.response.ok) {
    return fail(correlationId, "T05_VIEW_TICKET_UNAVAILABLE", await failEvidence({
      ticketResponse: redact(issued.response), observedTicketStatuses: issued.observed,
    }));
  }
  const firstToken = issued.response.body.ticket;
  const firstView = await client.getBytes(`/api/documents/${first.document.id}/file`, {
    headers: { authorization: `ArchiveTicket ${firstToken}`, "x-archive-access-scope": "VIEW" },
  });
  if (!firstView.ok || firstView.objectClass !== "access" || typeof firstView.sessionToken !== "string") {
    return fail(correlationId, "T05_FIRST_EXCHANGE_FAILED", await failEvidence({
      status: firstView.status, objectClass: firstView.objectClass ?? null,
    }));
  }

  const replay = await client.getBytes(`/api/documents/${first.document.id}/file`, {
    headers: { authorization: `ArchiveTicket ${firstToken}`, "x-archive-access-scope": "VIEW" },
  });
  const crossDocument = await client.getBytes(`/api/documents/${second.document.id}/file`, {
    headers: {
      authorization: `ArchiveSession ${firstView.sessionToken}`,
      "x-archive-access-scope": "VIEW",
    },
  });

  const expiring = await waitForViewTicket(client, ctx, first.document.id);
  const expiresAt = Date.parse(expiring.response.body?.expiresAt ?? "");
  if (!expiring.response.ok || !Number.isFinite(expiresAt)) {
    return fail(correlationId, "T05_EXPIRING_TICKET_UNAVAILABLE", await failEvidence({
      ticketResponse: redact(expiring.response),
    }));
  }
  const now = ctx.now ?? (() => Date.now());
  const wait = ctx.wait ?? ((ms) => sleep(ms, ctx.signal));
  await wait(Math.max(0, expiresAt - now() + 1_100));
  const expired = await client.getBytes(`/api/documents/${first.document.id}/file`, {
    headers: {
      authorization: `ArchiveTicket ${expiring.response.body.ticket}`,
      "x-archive-access-scope": "VIEW",
    },
  });

  if (!denialDownload(replay.status) || !denialDownload(expired.status)
    || !denialDownload(crossDocument.status)) {
    return fail(correlationId, "T05_DENIAL_SEMANTICS_INVALID", await failEvidence({
      replayStatus: replay.status,
      expiredStatus: expired.status,
      crossDocumentStatus: crossDocument.status,
    }));
  }

  const [firstEvidence, secondEvidence] = await Promise.all([
    readAcceptanceEvidence(client, ctx, first.flow.sessionId),
    readAcceptanceEvidence(client, ctx, second.flow.sessionId),
  ]);
  if (!firstEvidence.ok || !secondEvidence.ok) {
    return fail(correlationId, "T05_AUDIT_EVIDENCE_UNAVAILABLE", await failEvidence({
      firstEvidence: redact(firstEvidence), secondEvidence: redact(secondEvidence),
    }));
  }
  const firstAudit = firstEvidence.body.accessAudit ?? [];
  const secondAudit = secondEvidence.body.accessAudit ?? [];
  const issuedCount = firstAudit.filter((event) => event.action === "document.ticket-issued").length;
  const viewedCount = firstAudit.filter((event) => event.action === "document.viewed").length;
  const ticketDenials = firstAudit.filter((event) =>
    event.action === "document.access-denied" && event.details?.reason === "TICKET_INVALID").length;
  const sessionDenials = secondAudit.filter((event) =>
    event.action === "document.access-denied" && event.details?.reason === "SESSION_INVALID").length;
  if (issuedCount < 2 || viewedCount < 1 || ticketDenials < 2 || sessionDenials < 1) {
    return fail(correlationId, "T05_AUDIT_TRAIL_INCOMPLETE", await failEvidence({
      issuedCount, viewedCount, ticketDenials, sessionDenials,
    }));
  }

  const accessDenial = await ctx.writeEvidence("T-05-access-denial", "access-denial", {
    testId: "T-05", correlationId,
    firstExchangeStatus: firstView.status,
    replayStatus: replay.status,
    expiredStatus: expired.status,
    crossDocumentStatus: crossDocument.status,
    ticketTtlSeconds: 60,
    credentialValuesPersisted: false,
  });
  const audit = await ctx.writeEvidence("T-05-audit", "audit", {
    testId: "T-05", correlationId,
    firstDocumentAudit: firstAudit,
    secondDocumentAudit: secondAudit,
    counts: { issued: issuedCount, viewed: viewedCount, ticketDenials, sessionDenials },
  });
  return { result: "PASS", correlationId, evidence: [accessDenial, audit] };
}
