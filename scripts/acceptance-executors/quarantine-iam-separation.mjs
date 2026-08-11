/** K-4 ? Karantina nesnesi yaln?z tarama rol?nce okunabilir. */
import { randomUUID } from "node:crypto";

import {
  driveSingleUpload, fail, failureEvidence, readAcceptanceEvidence,
  redact, resolvePrivateObjectLocator,
} from "./flows.mjs";
import { buildPdfFixture, eicarSignature, sha256Hex } from "./fixtures.mjs";
import { createS3Client, isProviderDenied, maskedProviderResult } from "./s3-contract.mjs";

const KINDS = ["access-denial", "audit"];

export async function runQuarantineIamSeparation(client, ctx) {
  const correlationId = `${ctx.runId}:K-4`;
  const tag = `k4-${ctx.runId}-${randomUUID()}`;
  const bytes = buildPdfFixture({ text: tag, commentLine: eicarSignature() });
  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Kabul Testleri",
    originalName: `${tag}-eicar.pdf`,
    mediaType: "application/pdf",
    bytes,
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "K-4", KINDS, {
    testId: "K-4", correlationId, payloadSha256: sha256Hex(bytes), ...detail,
  });
  if (flow.failed || flow.poll?.status !== "REJECTED") {
    return fail(correlationId, "K4_FIXTURE_NOT_REJECTED", await failEvidence({
      flow: flow.failed ?? { status: flow.poll?.status, observed: flow.poll?.observed },
    }));
  }

  const [authoritative, locatorResponse] = await Promise.all([
    readAcceptanceEvidence(client, ctx, flow.sessionId),
    resolvePrivateObjectLocator(client, ctx, flow.sessionId, "quarantine"),
  ]);
  const locator = locatorResponse.body;
  if (!authoritative.ok || authoritative.body?.decisionCode !== "MALWARE_DETECTED"
      || !locatorResponse.ok || locator?.objectClass !== "quarantine"
      || locator?.sha256 !== flow.sha256 || typeof locator?.objectKey !== "string") {
    return fail(correlationId, "K4_QUARANTINE_EVIDENCE_UNAVAILABLE", await failEvidence({
      evidence: redact(authoritative), locator: redact(locatorResponse),
      decisionCode: authoritative.body?.decisionCode ?? null,
    }));
  }

  const keyDigest = sha256Hex(Buffer.from(locator.objectKey));
  const roleClients = Object.fromEntries(["viewer", "application", "scanner", "ocr"].map((role) => [
    role,
    createS3Client({
      endpoint: ctx.config.s3.endpoint,
      bucket: ctx.config.s3.quarantineBucket,
      region: ctx.config.s3.region,
      credentials: ctx.config.iamRoles?.[role],
      signal: ctx.signal,
      fetcher: ctx.config.s3.fetcher,
    }),
  ]));
  const reads = {};
  for (const [role, roleClient] of Object.entries(roleClients)) {
    reads[role] = await roleClient.get(locator.objectKey);
  }
  const appRoute = await client.json("GET", `/api/uploads/${flow.sessionId}/file`);
  const scannerSha = reads.scanner.ok ? sha256Hex(reads.scanner.bytes) : null;
  const allowedScanner = reads.scanner.ok && scannerSha === flow.sha256
    && reads.scanner.bytes.byteLength === bytes.byteLength;
  const deniedRoles = ["viewer", "application", "ocr"];
  const denied = deniedRoles.every((role) => isProviderDenied(reads[role]));
  const access = await ctx.writeEvidence("K-4-access-denial", "access-denial", {
    testId: "K-4", correlationId, keyDigest,
    normalApplicationRoute: redact(appRoute),
    roleReads: Object.fromEntries(Object.entries(reads).map(([role, result]) => [
      role, {
        expected: role === "scanner" ? "ALLOW" : "DENY",
        result: maskedProviderResult(result),
      },
    ])),
    scannerReadbackSha256: scannerSha,
  });
  const audit = await ctx.writeEvidence("K-4-audit", "audit", {
    testId: "K-4", correlationId,
    terminalStatus: authoritative.body.terminalStatus,
    decisionCode: authoritative.body.decisionCode,
    transitionChainValid: authoritative.body.transitionChain?.valid === true,
    scannerResult: authoritative.body.receipt?.scannerResult ?? null,
    forbiddenArtifactCounts: authoritative.body.counts,
    physicalKeyPersistedInEvidence: false,
  });
  const evidence = [access, audit];

  if (![403, 404, 405].includes(appRoute.status)) {
    return { result: "FAIL", correlationId, errorCode: "K4_APPLICATION_ROUTE_EXPOSED", evidence };
  }
  if (!denied) {
    return { result: "FAIL", correlationId, errorCode: "K4_QUARANTINE_ROLE_LEAK", evidence };
  }
  if (!allowedScanner) {
    return { result: "FAIL", correlationId, errorCode: "K4_SCANNER_CONTROL_FAILED", evidence };
  }
  if (authoritative.body.transitionChain?.valid !== true
      || authoritative.body.receipt?.scannerResult !== "MALICIOUS") {
    return { result: "FAIL", correlationId, errorCode: "K4_REJECTION_AUDIT_INVALID", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
