/** T-12 ? ger?ek staging deposunda iki y?nl? uzla?t?rma probu. */

import { randomUUID } from "node:crypto";

import { driveSingleUpload, fail, failureEvidence, redact } from "./flows.mjs";
import { buildPdfFixture } from "./fixtures.mjs";

const EVIDENCE_KINDS = ["reconciliation", "finding"];

function acceptanceToken(ctx) {
  return ctx.config.acceptanceToken ?? ctx.acceptanceToken;
}

export async function runBidirectionalReconciliation(client, ctx) {
  const correlationId = `${ctx.runId}:T-12`;
  const tag = `t12-${ctx.runId}-${randomUUID()}`;
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-12", EVIDENCE_KINDS, {
    correlationId, ...detail,
  });
  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Kabul Testleri",
    originalName: `${tag}.pdf`,
    mediaType: "application/pdf",
    bytes: buildPdfFixture({ text: tag }),
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 4 * 60_000,
  });
  if (flow.failed || flow.poll.status !== "ACCEPTED") {
    return fail(correlationId, "T12_FIXTURE_UPLOAD_FAILED", await failEvidence({
      flow: flow.failed ?? null, finalStatus: flow.poll?.status ?? null,
    }));
  }
  const token = acceptanceToken(ctx);
  if (typeof token !== "string" || token.length < 32) {
    return fail(correlationId, "T12_ACCEPTANCE_TOKEN_MISSING", await failEvidence({}));
  }
  const response = await client.json("POST",
    `/api/admin/acceptance-evidence/${encodeURIComponent(flow.sessionId)}`, {
      headers: { authorization: `Bearer ${token}` },
      body: { action: "RUN_RECONCILIATION_PROBE" },
    });
  if (!response.ok) {
    return fail(correlationId, "T12_RECONCILIATION_PROBE_FAILED", await failEvidence({
      response: redact(response),
    }));
  }
  const report = response.body;
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const orphan = findings.find((finding) => finding.findingType === "ORPHAN_OBJECT");
  const missing = findings.find((finding) => finding.findingType === "MISSING_OBJECT");
  const valid = report?.run?.status === "COMPLETED"
    && Number.isSafeInteger(report.run.binarySnapshotMaxRowid) && report.run.binarySnapshotMaxRowid > 0
    && Number.isSafeInteger(report.run.documentSnapshotMaxRowid) && report.run.documentSnapshotMaxRowid > 0
    && findings.length === 2
    && orphan?.recordKind === "STORAGE_OBJECT" && orphan?.recordId === null
    && orphan?.objectKeyDigest === report.expectations?.orphanKeyDigest
    && orphan?.status === "OPEN"
    && missing?.recordKind === "BINARY_OBJECT"
    && missing?.recordId === report.expectations?.missingObjectId
    && missing?.status === "OPEN"
    && report.expectations?.youngControlFindingCount === 0
    && report.expectations?.orphanObjectStillPresent === true;
  if (!valid) {
    return fail(correlationId, "T12_RECONCILIATION_EVIDENCE_INVALID", await failEvidence({
      runStatus: report?.run?.status ?? null,
      findingTypes: findings.map((finding) => finding.findingType),
      youngControlFindingCount: report?.expectations?.youngControlFindingCount ?? null,
      orphanObjectStillPresent: report?.expectations?.orphanObjectStillPresent ?? null,
    }));
  }

  const reconciliation = await ctx.writeEvidence("T-12-reconciliation", "reconciliation", {
    testId: "T-12", correlationId, sessionId: flow.sessionId,
    run: report.run,
    snapshotWatermarks: {
      binary: report.run.binarySnapshotMaxRowid,
      document: report.run.documentSnapshotMaxRowid,
    },
    youngObjectToleranceApplied: true,
    automaticDeletionObserved: false,
  });
  const finding = await ctx.writeEvidence("T-12-finding", "finding", {
    testId: "T-12", correlationId,
    findings,
    expectedDigests: {
      orphan: report.expectations.orphanKeyDigest,
      youngControl: report.expectations.youngKeyDigest,
    },
    orphanObjectStillPresent: true,
    resolutionStatuses: findings.map((entry) => entry.status),
  });
  return { result: "PASS", correlationId, evidence: [reconciliation, finding] };
}
