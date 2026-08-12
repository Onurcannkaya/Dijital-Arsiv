/** T-08 ? Ayr? okuma adapt?r?nde tam-SHA uyu?mazl??? ve alarm kan?t?. */
import { randomUUID } from "node:crypto";
import { driveSingleUpload, fail, failureEvidence, redact } from "./flows.mjs";
import { buildPdfFixture } from "./fixtures.mjs";

const KINDS = ["finding", "alarm"];

export async function runIntegrityMismatchDetection(client, ctx) {
  const correlationId = `${ctx.runId}:T-08`;
  const tag = `t08-${ctx.runId}-${randomUUID()}`;
  const bytes = buildPdfFixture({ text: tag });
  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Kabul Testleri",
    originalName: `${tag}.pdf`,
    mediaType: "application/pdf",
    bytes,
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-08", KINDS, {
    testId: "T-08", correlationId, ...detail,
  });
  if (flow.failed || flow.poll?.status !== "ACCEPTED") {
    return fail(correlationId, "T08_FIXTURE_NOT_ACCEPTED", await failEvidence({
      flow: flow.failed ?? { status: flow.poll?.status, observed: flow.poll?.observed },
    }));
  }
  const probe = await client.json("POST",
    `/api/admin/acceptance-evidence/${encodeURIComponent(flow.sessionId)}`, {
      headers: { authorization: `Bearer ${ctx.config.acceptanceToken}` },
      body: { action: "RUN_INTEGRITY_MISMATCH_PROBE", guard: "confirmed-non-production" },
    });
  if (!probe.ok) {
    return fail(correlationId, "T08_INTEGRITY_PROBE_FAILED", await failEvidence({
      probe: redact(probe),
    }));
  }
  const body = probe.body;
  const finding = await ctx.writeEvidence("T-08-finding", "finding", {
    testId: "T-08", correlationId,
    run: body?.run ?? null,
    finding: body?.finding ?? null,
    transientProviderFailure: body?.transientProviderFailure ?? null,
    originalAfterProbe: body?.originalAfterProbe ?? null,
  });
  const alarm = await ctx.writeEvidence("T-08-alarm", "alarm", {
    testId: "T-08", correlationId,
    alarm: body?.alarm ?? null,
    correlationMatchesFinding: body?.alarm?.correlationId === body?.finding?.id,
    automaticRepairObserved: body?.originalAfterProbe?.unchanged !== true,
  });
  const evidence = [finding, alarm];

  if (body?.run?.status !== "COMPLETED" || body.run.profile !== "full"
      || body.run.findingCount !== 1 || body?.finding?.findingType !== "HASH_MISMATCH"
      || body.finding.status !== "OPEN") {
    return { result: "FAIL", correlationId, errorCode: "T08_PERSISTENT_FINDING_INVALID", evidence };
  }
  if (body?.alarm?.correlationId !== body?.finding?.id) {
    return { result: "FAIL", correlationId, errorCode: "T08_ALARM_CORRELATION_INVALID", evidence };
  }
  if (body?.transientProviderFailure?.propagatedForRetry !== true
      || body.transientProviderFailure.persistedFindingCount !== 0) {
    return { result: "FAIL", correlationId, errorCode: "T08_TRANSIENT_FAILURE_MISCLASSIFIED", evidence };
  }
  if (body?.originalAfterProbe?.unchanged !== true
      || body.originalAfterProbe.sha256 !== flow.sha256) {
    return { result: "FAIL", correlationId, errorCode: "T08_SILENT_REPAIR_OR_MUTATION", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
