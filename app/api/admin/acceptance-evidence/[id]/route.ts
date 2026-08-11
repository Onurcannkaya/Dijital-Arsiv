import {
  AcceptanceEvidenceNotFoundError,
  readAcceptanceEvidence,
  enqueueAcceptanceSecondDerivative,
  resolveAcceptancePrivateObjectLocator,
  acceptanceEvidenceAccessDecision,
} from "../../../../../lib/acceptance-evidence";
import {
  getArchiveBindings, jsonError, requireArchiveSchema,
} from "../../../../../lib/archive-storage";
import { failure } from "../../../../../lib/errors";
import { runAcceptanceReconciliationProbe } from "../../../../../lib/acceptance-reconciliation";
import { runAcceptanceIntegrityProbe } from "../../../../../lib/acceptance-integrity";
import { correlationId, logEvent } from "../../../../../lib/observability";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

function noStore(response: Response, requestId: string) {
  response.headers.set("cache-control", "no-store, private");
  response.headers.set("x-correlation-id", requestId);
  return response;
}

export async function GET(request: Request, context: RouteContext) {
  const requestId = correlationId(request);
  try {
    const bindings = getArchiveBindings();
    const refused = await acceptanceEvidenceAccessDecision({
      appEnv: bindings.APP_ENV,
      configuredToken: bindings.ARCHIVE_ACCEPTANCE_TOKEN,
      authorization: request.headers.get("authorization"),
    });
    if (refused) {
      return noStore(jsonError(refused.message, refused.status), requestId);
    }
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return noStore(schemaError, requestId);

    const { id } = await context.params;
    const evidence = await readAcceptanceEvidence(bindings.DB, id);
    logEvent("info", "acceptance.evidence-read", {
      correlationId: requestId,
      terminalStatus: evidence.terminalStatus,
      decisionCode: evidence.decisionCode,
      transitionCount: evidence.transitionChain.events.length,
    });
    return noStore(Response.json(evidence), requestId);
  } catch (error) {
    if (error instanceof AcceptanceEvidenceNotFoundError) {
      return noStore(jsonError("Kabul oturumu bulunamad?.", 404), requestId);
    }
    return noStore(failure(
      error, "acceptance.evidence-read", "Kabul kan?t? okunamad?.", request,
    ), requestId);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = correlationId(request);
  try {
    const bindings = getArchiveBindings();
    const refused = await acceptanceEvidenceAccessDecision({
      appEnv: bindings.APP_ENV,
      configuredToken: bindings.ARCHIVE_ACCEPTANCE_TOKEN,
      authorization: request.headers.get("authorization"),
    });
    if (refused) return noStore(jsonError(refused.message, refused.status), requestId);
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return noStore(schemaError, requestId);
    const body = await request.json().catch(() => null) as { action?: unknown; objectClass?: unknown; guard?: unknown } | null;
    const { id } = await context.params;
    if (body?.action === "RESOLVE_PRIVATE_OBJECT_LOCATOR") {
      if (body.objectClass !== "original" && body.objectClass !== "quarantine") {
        return noStore(jsonError("Ge?ersiz nesne s?n?f?."), requestId);
      }
      const locator = await resolveAcceptancePrivateObjectLocator(bindings.DB, id, body.objectClass);
      logEvent("info", "acceptance.private-locator-resolved", {
        correlationId: requestId,
        objectClass: locator.objectClass,
        // Fiziksel anahtar loglanmaz; yaln?z kabul ko?usu belle?ine d?ner.
        byteSize: locator.byteSize,
      });
      return noStore(Response.json(locator), requestId);
    }
    if (body?.action === "RUN_POST_PROMOTION_DB_FAILURE_PROBE") {
      if (body.guard !== "confirmed-non-production") {
        return noStore(jsonError("Kabul hata enjeksiyonu ortam korumas? gerektirir.", 403), requestId);
      }
      await readAcceptanceEvidence(bindings.DB, id);
      const probe = await runAcceptanceReconciliationProbe({
        db: bindings.DB, archive: bindings.ARCHIVE_FILES, sessionId: id,
      });
      logEvent("warn", "acceptance.post-promotion-db-failure-probe-completed", {
        correlationId: requestId,
        runId: probe.run.id,
        orphanObjectStillPresent: probe.expectations.orphanObjectStillPresent,
      });
      return noStore(Response.json({
        ...probe, probeMode: "POST_PROMOTION_DB_FAILURE",
      }), requestId);
    }
    if (body?.action === "RUN_INTEGRITY_MISMATCH_PROBE") {
      if (body.guard !== "confirmed-non-production") {
        return noStore(jsonError("B?t?nl?k probu ortam korumas? gerektirir.", 403), requestId);
      }
      await readAcceptanceEvidence(bindings.DB, id);
      const probe = await runAcceptanceIntegrityProbe({
        db: bindings.DB, archive: bindings.ARCHIVE_FILES, sessionId: id,
      });
      logEvent("warn", "acceptance.integrity-mismatch-probe-completed", {
        correlationId: requestId,
        runId: probe.run.id,
        findingId: probe.finding.id,
      });
      return noStore(Response.json(probe), requestId);
    }
    if (body?.action === "RUN_RECONCILIATION_PROBE") {
      await readAcceptanceEvidence(bindings.DB, id);
      const probe = await runAcceptanceReconciliationProbe({
        db: bindings.DB, archive: bindings.ARCHIVE_FILES, sessionId: id,
      });
      logEvent("info", "acceptance.reconciliation-probe-completed", {
        correlationId: requestId,
        runId: probe.run.id,
        findingCount: probe.findings.length,
      });
      return noStore(Response.json(probe), requestId);
    }
    if (body?.action !== "ENQUEUE_SECOND_DERIVATIVE_PROFILE") {
      return noStore(jsonError("Ge?ersiz kabul kan?t? i?lemi."), requestId);
    }
    const queued = await enqueueAcceptanceSecondDerivative(bindings.DB, id);
    logEvent("info", "acceptance.derivative-profile-enqueued", {
      correlationId: requestId,
      profileVersion: queued.profileVersion,
      enqueued: queued.enqueued,
    });
    return noStore(Response.json(queued, { status: queued.enqueued ? 202 : 200 }), requestId);
  } catch (error) {
    if (error instanceof AcceptanceEvidenceNotFoundError) {
      return noStore(jsonError("Kabul oturumu bulunamad?.", 404), requestId);
    }
    return noStore(failure(
      error, "acceptance.operation",
      "Kabul kan?t? i?lemi tamamlanamad?.", request,
    ), requestId);
  }
}
