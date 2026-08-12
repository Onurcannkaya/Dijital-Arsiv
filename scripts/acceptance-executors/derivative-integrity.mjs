/**
 * T-03 ? As?l de?i?meden iki profil s?r?m?nde eri?im t?revi ?retilir.
 *
 * Kabul kan?t?; as?l?n kimlik/SHA/s?r?m envanterini ?nce ve sonra kar??la?t?r?r,
 * v1 ile v2 ?retim ku?aklar?n? anahtars?z envanterden do?rular ve VIEW/DOWNLOAD
 * biletleriyle sunulan baytlar?n do?ru nesne s?n?f?ndan geldi?ini d??ar?dan ?l?er.
 */

import { randomUUID } from "node:crypto";

import { sleep } from "./contract.mjs";
import {
  driveSingleUpload, enqueueAcceptanceSecondDerivative, fail, failureEvidence,
  readAcceptanceEvidence, redact,
} from "./flows.mjs";
import { buildPdfFixture, sha256Hex } from "./fixtures.mjs";

const EVIDENCE_KINDS = ["inventory", "integrity"];
const REQUIRED_PROFILES = ["access-pdf-v1", "access-pdf-v2"];
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

function snapshotOriginal(original) {
  return {
    id: original.id,
    sha256: original.sha256,
    byteSize: original.byteSize,
    storageVersionId: original.storageVersionId,
  };
}

function inspectDerivativeEvidence(body, original) {
  const jobs = Array.isArray(body?.derivativeJobs) ? body.derivativeJobs : [];
  const derivatives = Array.isArray(body?.derivativeInventory) ? body.derivativeInventory : [];
  const requiredJobs = REQUIRED_PROFILES.map((profile) =>
    jobs.find((job) => job.profileVersion === profile));
  const terminalFailure = jobs.find((job) => ["FAILED", "REVIEW_REQUIRED"].includes(job.status));
  if (terminalFailure) return { ready: true, error: "T03_DERIVATIVE_JOB_FAILED", jobs, derivatives };
  if (requiredJobs.some((job) => !job || job.status !== "COMPLETED")) {
    return { ready: false, jobs, derivatives };
  }
  for (const job of requiredJobs) {
    if (job.sourceBinaryObjectId !== original.id || !job.renderer || !job.rendererVersion
      || !IMAGE_DIGEST.test(job.rendererImageDigest ?? "")
      || !Number.isSafeInteger(job.pageCount) || job.pageCount < 1
      || !Number.isSafeInteger(job.segmentCount) || job.segmentCount < 1
      || !job.completedAt) {
      return { ready: true, error: "T03_RENDER_PROVENANCE_INVALID", jobs, derivatives };
    }
  }
  const generationIds = new Set(requiredJobs.map((job) => job.id));
  const expectedSegments = requiredJobs.reduce((total, job) => total + job.segmentCount, 0);
  const selected = derivatives.filter((object) => generationIds.has(object.generationId));
  if (selected.length !== expectedSegments || selected.some((object) =>
    object.derivedFromId !== original.id || object.mediaType !== "application/pdf"
    || !SHA256.test(object.sha256 ?? "") || !object.generator
    || !Number.isSafeInteger(object.pageStart) || !Number.isSafeInteger(object.pageEnd)
    || object.pageEnd < object.pageStart)) {
    return { ready: true, error: "T03_DERIVATIVE_INVENTORY_INVALID", jobs, derivatives };
  }
  return { ready: true, jobs: requiredJobs, derivatives: selected };
}

async function pollDerivatives(client, ctx, sessionId, original) {
  const timeoutMs = ctx.derivativeTimeoutMs ?? 6 * 60_000;
  const deadline = Date.now() + timeoutMs;
  const observed = [];
  for (;;) {
    const response = await readAcceptanceEvidence(client, ctx, sessionId);
    if (!response.ok) return { error: "T03_EVIDENCE_UNAVAILABLE", response: redact(response), observed };
    const inspected = inspectDerivativeEvidence(response.body, original);
    const state = (response.body.derivativeJobs ?? [])
      .map((job) => `${job.profileVersion}:${job.status}`).sort().join(",") || "NONE";
    if (observed.at(-1) !== state) observed.push(state);
    if (inspected.ready) return { ...inspected, body: response.body, observed };
    if (Date.now() >= deadline) return { error: "T03_DERIVATIVE_TIMEOUT", observed };
    await sleep(ctx.intervalMs ?? 5_000, ctx.signal);
  }
}

async function issueTicket(client, documentId, scope) {
  return client.json("POST", `/api/documents/${documentId}/access-ticket`, {
    body: {
      scope,
      purpose: scope === "VIEW" ? "DOCUMENT_REVIEW" : "ORIGINAL_DOWNLOAD",
    },
  });
}

export async function runDerivativeIntegrity(client, ctx) {
  const correlationId = `${ctx.runId}:T-03`;
  const unit = ctx.config.unit ?? "Yaz? ??leri";
  const tag = `t03-${ctx.runId}-${randomUUID()}`;
  const originalName = `${tag}.pdf`;
  const bytes = buildPdfFixture({ text: tag });
  const localSha256 = sha256Hex(bytes);
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-03", EVIDENCE_KINDS, {
    correlationId, localSha256, ...detail,
  });

  const flow = await driveSingleUpload(client, ctx, {
    unit, originalName, mediaType: "application/pdf", bytes,
    idempotencyKey: tag, timeoutMs: ctx.timeoutMs ?? 4 * 60_000,
  });
  if (flow.failed || flow.poll.status !== "ACCEPTED") {
    return fail(correlationId, "T03_UPLOAD_NOT_ACCEPTED", await failEvidence({
      flow: flow.failed ?? null, finalStatus: flow.poll?.status ?? null,
    }));
  }

  const beforeResponse = await readAcceptanceEvidence(client, ctx, flow.sessionId);
  const beforeOriginals = beforeResponse.body?.originalInventory;
  const original = Array.isArray(beforeOriginals) && beforeOriginals.length === 1
    ? beforeOriginals[0] : null;
  if (!beforeResponse.ok || !original || original.sha256 !== localSha256
    || original.byteSize !== bytes.byteLength || typeof original.storageVersionId !== "string"
    || !original.storageVersionId) {
    return fail(correlationId, "T03_ORIGINAL_BASELINE_INVALID", await failEvidence({
      evidenceResponse: redact(beforeResponse), originalCount: beforeOriginals?.length ?? null,
    }));
  }
  const beforeSnapshot = snapshotOriginal(original);

  const enqueued = await enqueueAcceptanceSecondDerivative(client, ctx, flow.sessionId);
  if (!enqueued.ok || enqueued.body?.profileVersion !== "access-pdf-v2") {
    return fail(correlationId, "T03_SECOND_PROFILE_ENQUEUE_FAILED", await failEvidence({
      enqueueResponse: redact(enqueued),
    }));
  }

  const generated = await pollDerivatives(client, ctx, flow.sessionId, original);
  if (generated.error) {
    return fail(correlationId, generated.error, await failEvidence({
      observedDerivativeStates: generated.observed,
    }));
  }
  const afterOriginals = generated.body?.originalInventory;
  const afterOriginal = Array.isArray(afterOriginals) && afterOriginals.length === 1
    ? snapshotOriginal(afterOriginals[0]) : null;
  if (!afterOriginal || JSON.stringify(afterOriginal) !== JSON.stringify(beforeSnapshot)) {
    return fail(correlationId, "T03_ORIGINAL_MUTATED", await failEvidence({
      beforeOriginal: beforeSnapshot, afterOriginal,
    }));
  }

  const listed = await client.json("GET", `/api/documents?q=${encodeURIComponent(tag)}`);
  const document = Array.isArray(listed.body?.documents)
    ? listed.body.documents.find((entry) => entry.originalName === originalName) : null;
  if (!listed.ok || !document) {
    return fail(correlationId, "T03_DOCUMENT_NOT_FOUND", await failEvidence({ listStatus: listed.status }));
  }

  const viewTicket = await issueTicket(client, document.id, "VIEW");
  if (!viewTicket.ok || typeof viewTicket.body?.ticket !== "string") {
    return fail(correlationId, "T03_VIEW_TICKET_DENIED", await failEvidence({ status: viewTicket.status }));
  }
  const view = await client.getBytes(`/api/documents/${document.id}/file`, {
    headers: {
      authorization: `ArchiveTicket ${viewTicket.body.ticket}`,
      "x-archive-access-scope": "VIEW",
    },
  });
  const viewSha256 = sha256Hex(view.bytes);
  if (!view.ok || view.objectClass !== "access"
    || !generated.derivatives.some((object) => object.sha256 === viewSha256)) {
    return fail(correlationId, "T03_VIEW_DERIVATIVE_INVALID", await failEvidence({
      viewStatus: view.status, objectClass: view.objectClass ?? null, viewSha256,
    }));
  }

  const downloadTicket = await issueTicket(client, document.id, "DOWNLOAD");
  if (!downloadTicket.ok || typeof downloadTicket.body?.ticket !== "string") {
    return fail(correlationId, "T03_DOWNLOAD_TICKET_DENIED", await failEvidence({ status: downloadTicket.status }));
  }
  const download = await client.getBytes(`/api/documents/${document.id}/file`, {
    headers: {
      authorization: `ArchiveTicket ${downloadTicket.body.ticket}`,
      "x-archive-access-scope": "DOWNLOAD",
    },
  });
  const downloadedSha256 = sha256Hex(download.bytes);
  if (!download.ok || download.objectClass !== "original" || downloadedSha256 !== localSha256) {
    return fail(correlationId, "T03_ORIGINAL_REREAD_INVALID", await failEvidence({
      downloadStatus: download.status, objectClass: download.objectClass ?? null, downloadedSha256,
    }));
  }

  const inventory = await ctx.writeEvidence("T-03-inventory", "inventory", {
    testId: "T-03", correlationId, sessionId: flow.sessionId, documentId: document.id,
    beforeOriginal: beforeSnapshot, afterOriginal, originalUnchanged: true,
    derivativeJobs: generated.jobs, derivatives: generated.derivatives,
    observedDerivativeStates: generated.observed,
  });
  const integrity = await ctx.writeEvidence("T-03-integrity", "integrity", {
    testId: "T-03", correlationId, localSha256, downloadedSha256, viewSha256,
    viewObjectClass: view.objectClass, downloadObjectClass: download.objectClass,
    viewShaInAuthorizedInventory: true, originalRereadMatches: true,
  });
  return { result: "PASS", correlationId, evidence: [inventory, integrity] };
}
