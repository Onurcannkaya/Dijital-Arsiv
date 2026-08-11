/** K-5 ? As?l yaz?l?p DB sonland?rmas? yap?lmad???nda nesne korunur ve uzla?t?r?l?r. */
import { randomUUID } from "node:crypto";

import {
  driveSingleUpload, fail, failureEvidence, readAcceptanceEvidence, redact,
} from "./flows.mjs";
import { buildPdfFixture } from "./fixtures.mjs";

const KINDS = ["fault-injection", "reconciliation"];

export async function runPostPromotionDbFailure(client, ctx) {
  const correlationId = `${ctx.runId}:K-5`;
  const tag = `k5-${ctx.runId}-${randomUUID()}`;
  const bytes = buildPdfFixture({ text: tag });
  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Kabul Testleri",
    originalName: `${tag}.pdf`,
    mediaType: "application/pdf",
    bytes,
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "K-5", KINDS, {
    testId: "K-5", correlationId, ...detail,
  });
  if (flow.failed || flow.poll?.status !== "ACCEPTED") {
    return fail(correlationId, "K5_CONTROL_FIXTURE_NOT_ACCEPTED", await failEvidence({
      flow: flow.failed ?? { status: flow.poll?.status, observed: flow.poll?.observed },
    }));
  }
  const token = ctx.config.acceptanceToken;
  const probe = await client.json("POST",
    `/api/admin/acceptance-evidence/${encodeURIComponent(flow.sessionId)}`, {
      headers: { authorization: `Bearer ${token}` },
      body: {
        action: "RUN_POST_PROMOTION_DB_FAILURE_PROBE",
        guard: "confirmed-non-production",
      },
    });
  if (!probe.ok) {
    return fail(correlationId, "K5_FAULT_PROBE_FAILED", await failEvidence({
      probe: redact(probe),
    }));
  }
  const authoritative = await readAcceptanceEvidence(client, ctx, flow.sessionId);
  const orphan = probe.body?.findings?.find((finding) =>
    finding.findingType === "ORPHAN_OBJECT"
      && finding.objectKeyDigest === probe.body?.expectations?.orphanKeyDigest);
  const injected = await ctx.writeEvidence("K-5-fault-injection", "fault-injection", {
    testId: "K-5", correlationId,
    probeMode: probe.body?.probeMode ?? null,
    controlSessionStatus: authoritative.body?.terminalStatus ?? null,
    injectedBoundary: "after immutable object creation, before database finalization",
    productionGuard: "confirmed-non-production",
  });
  const reconciliation = await ctx.writeEvidence("K-5-reconciliation", "reconciliation", {
    testId: "K-5", correlationId,
    run: probe.body?.run ?? null,
    orphanFinding: orphan ?? null,
    orphanObjectStillPresent: probe.body?.expectations?.orphanObjectStillPresent ?? false,
    automaticDeletionObserved: probe.body?.expectations?.orphanObjectStillPresent === false,
  });
  const evidence = [injected, reconciliation];

  if (!authoritative.ok || authoritative.body?.terminalStatus !== "ACCEPTED") {
    return { result: "FAIL", correlationId, errorCode: "K5_CONTROL_EVIDENCE_INVALID", evidence };
  }
  if (probe.body?.probeMode !== "POST_PROMOTION_DB_FAILURE"
      || probe.body?.run?.status !== "COMPLETED" || !orphan) {
    return { result: "FAIL", correlationId, errorCode: "K5_ORPHAN_NOT_RECONCILED", evidence };
  }
  if (probe.body?.expectations?.orphanObjectStillPresent !== true) {
    return { result: "FAIL", correlationId, errorCode: "K5_ORIGINAL_DELETED_AFTER_DB_FAILURE", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
