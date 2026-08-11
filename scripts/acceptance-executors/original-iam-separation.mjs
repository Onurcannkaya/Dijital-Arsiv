/** T-06 ? Rol bazl? as?l kasa IAM matrisi ve uygulama yetki reddi. */
import { randomUUID } from "node:crypto";

import { createAppClient } from "./contract.mjs";
import {
  driveSingleUpload, fail, failureEvidence, readAcceptanceEvidence,
  redact, resolvePrivateObjectLocator,
} from "./flows.mjs";
import { buildPdfFixture, sha256Hex } from "./fixtures.mjs";
import { createS3Client, isProviderDenied, maskedProviderResult } from "./s3-contract.mjs";

const KINDS = ["access-denial", "integrity"];
const ROLE_EXPECTATIONS = Object.freeze({
  viewer: { get: "DENY", put: "DENY", delete: "DENY" },
  application: { get: "DENY", put: "DENY", delete: "DENY" },
  scanner: { get: "DENY", put: "DENY", delete: "DENY" },
  ocr: { get: "ALLOW", put: "DENY", delete: "DENY" },
});

export async function runOriginalIamSeparation(client, ctx) {
  const correlationId = `${ctx.runId}:T-06`;
  const tag = `t06-${ctx.runId}-${randomUUID()}`;
  const bytes = buildPdfFixture({ text: tag });
  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Kabul Testleri",
    originalName: `${tag}.pdf`,
    mediaType: "application/pdf",
    bytes,
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-06", KINDS, {
    testId: "T-06", correlationId, expectedSha256: sha256Hex(bytes), ...detail,
  });
  if (flow.failed || flow.poll?.status !== "ACCEPTED") {
    return fail(correlationId, "T06_FIXTURE_NOT_ACCEPTED", await failEvidence({
      flow: flow.failed ?? { status: flow.poll?.status, observed: flow.poll?.observed },
    }));
  }
  const [authoritative, locatorResponse] = await Promise.all([
    readAcceptanceEvidence(client, ctx, flow.sessionId),
    resolvePrivateObjectLocator(client, ctx, flow.sessionId, "original"),
  ]);
  const locator = locatorResponse.body;
  if (!authoritative.ok || !locatorResponse.ok || typeof locator?.objectKey !== "string"
      || locator.objectClass !== "original" || locator.sha256 !== flow.sha256) {
    return fail(correlationId, "T06_PRIVATE_LOCATOR_UNAVAILABLE", await failEvidence({
      evidence: redact(authoritative), locator: redact(locatorResponse),
    }));
  }
  const keyDigest = sha256Hex(Buffer.from(locator.objectKey));
  const overwriteBytes = Buffer.from(`forbidden-overwrite:${tag}`);
  const clients = Object.fromEntries(Object.entries(ctx.config.iamRoles ?? {}).map(([role, credentials]) => [
    role,
    createS3Client({
      endpoint: ctx.config.s3.endpoint,
      bucket: ctx.config.s3.originalBucket,
      region: ctx.config.s3.region,
      credentials,
      signal: ctx.signal,
      fetcher: ctx.config.s3.fetcher,
    }),
  ]));

  if (Object.keys(clients).sort().join(",") !== Object.keys(ROLE_EXPECTATIONS).sort().join(",")) {
    return fail(correlationId, "T06_IAM_ROLE_SET_INCOMPLETE", await failEvidence({ keyDigest }));
  }

  // ?nce salt-okuma matrisi; OCR yetkili as?l okuyucudur, di?er roller de?ildir.
  const results = {};
  for (const [role, roleClient] of Object.entries(clients)) {
    const get = await roleClient.get(locator.objectKey);
    results[role] = { get };
  }
  // Mutasyonlar ayr? ve s?ral? denenir; hatal? bir izin sonraki b?t?nl?k
  // kontrol?nde g?r?n?r, fakat yar?? ko?ulu test sonucunu maskelemez.
  for (const [role, roleClient] of Object.entries(clients)) {
    results[role].put = await roleClient.put(locator.objectKey, overwriteBytes);
    results[role].delete = await roleClient.delete(locator.objectKey);
  }

  const unauthorizedClient = (ctx.createAppClient ?? createAppClient)({
    baseUrl: ctx.config.baseUrl,
    identity: ctx.config.identities?.unauthorized,
    signal: ctx.signal,
  });
  const documentId = authoritative.body?.originalInventory?.[0]?.id
    ? (await client.json("GET", `/api/documents?q=${encodeURIComponent(tag)}`))
      .body?.documents?.find((entry) => entry.originalName === `${tag}.pdf`)?.id
    : null;
  const appDenied = documentId
    ? await unauthorizedClient.json("POST", `/api/documents/${documentId}/access-ticket`, {
        body: { scope: "DOWNLOAD", purpose: "ORIGINAL_DOWNLOAD" },
      })
    : { status: 0, ok: false, body: { code: "DOCUMENT_NOT_FOUND" } };

  const finalRead = await clients.ocr.get(locator.objectKey);
  const finalSha = finalRead.ok ? sha256Hex(finalRead.bytes) : null;
  const roleEvidence = Object.fromEntries(Object.entries(results).map(([role, operations]) => [
    role,
    {
      expected: ROLE_EXPECTATIONS[role],
      get: maskedProviderResult(operations.get),
      put: maskedProviderResult(operations.put),
      delete: maskedProviderResult(operations.delete),
    },
  ]));
  const access = await ctx.writeEvidence("T-06-access-denial", "access-denial", {
    testId: "T-06", correlationId, keyDigest,
    applicationApi: redact(appDenied),
    physicalRoleMatrix: roleEvidence,
    policyReference: "ADR-014 ?physical-domains; ADR-016 ?application-and-identity",
  });
  const matrixValid = Object.entries(results).every(([role, operations]) => {
    const getValid = ROLE_EXPECTATIONS[role].get === "ALLOW"
      ? operations.get.ok && sha256Hex(operations.get.bytes) === flow.sha256
      : isProviderDenied(operations.get);
    return getValid && isProviderDenied(operations.put) && isProviderDenied(operations.delete);
  });
  const unchanged = finalRead.ok && finalSha === flow.sha256
    && finalRead.bytes.byteLength === bytes.byteLength;
  const integrity = await ctx.writeEvidence("T-06-integrity", "integrity", {
    testId: "T-06", correlationId, keyDigest,
    expectedSha256: flow.sha256,
    finalSha256: finalSha,
    expectedByteSize: bytes.byteLength,
    finalByteSize: finalRead.ok ? finalRead.bytes.byteLength : null,
    matrixValid,
    unchanged,
  });
  const evidence = [access, integrity];

  if (appDenied.status !== 403) {
    return { result: "FAIL", correlationId, errorCode: "T06_APPLICATION_AUTHORIZATION_NOT_DENIED", evidence };
  }
  if (!matrixValid) {
    return { result: "FAIL", correlationId, errorCode: "T06_IAM_MATRIX_VIOLATION", evidence };
  }
  if (!unchanged) {
    return { result: "FAIL", correlationId, errorCode: "T06_ORIGINAL_CHANGED", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
