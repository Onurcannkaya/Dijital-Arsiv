/** T-11 ? Fiziksel anahtar, custom metadata ve eri?im logu ki?isel veri taramas?. */
import { randomUUID } from "node:crypto";

import { sleep } from "./contract.mjs";
import {
  driveSingleUpload, fail, failureEvidence, readAcceptanceEvidence,
  redact, resolvePrivateObjectLocator,
} from "./flows.mjs";
import { buildPdfFixture, sha256Hex } from "./fixtures.mjs";
import { createS3Client, maskedProviderResult } from "./s3-contract.mjs";

const KINDS = ["secret-scan", "finding-summary"];

function markerHits(value, markers) {
  const normalized = String(value ?? "").toLocaleLowerCase("tr-TR");
  return markers.filter((marker) => normalized.includes(marker.toLocaleLowerCase("tr-TR")));
}

async function readCorrelatedLogs(ctx) {
  const fetcher = ctx.config.logFetcher ?? fetch;
  const endpoint = new URL(ctx.config.logEndpoint);
  endpoint.searchParams.set("correlationId", ctx.requestCorrelationId);
  endpoint.searchParams.set("limit", "500");
  let last = { status: 0, ok: false, records: [] };
  for (let attempt = 0; attempt < (ctx.logAttempts ?? 12); attempt += 1) {
    const response = await fetcher(endpoint, {
      headers: { authorization: `Bearer ${ctx.config.logToken}` },
      signal: ctx.signal,
    });
    let body = null;
    try { body = await response.json(); } catch { /* fail-closed a?a??da */ }
    const records = Array.isArray(body) ? body : Array.isArray(body?.records) ? body.records : [];
    last = { status: response.status, ok: response.ok, records };
    if (response.ok && records.length > 0) return last;
    await sleep(ctx.logIntervalMs ?? 5_000, ctx.signal);
  }
  return last;
}

export async function runPersonalDataSurfaceScan(client, ctx) {
  const correlationId = `${ctx.runId}:T-11`;
  const tag = `t11-${ctx.runId}-${randomUUID()}`;
  const markers = [
    "Ahmet Yilmaz",
    "Ataturk Mahallesi 12",
    "Ada 123 Parsel 45",
    "10000000146",
  ];
  const originalName = `${tag} ${markers.join(" ")}.pdf`;
  const bytes = buildPdfFixture({ text: tag });
  const markerDigests = markers.map((marker) => sha256Hex(Buffer.from(marker)));
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-11", KINDS, {
    testId: "T-11", correlationId, markerDigests, ...detail,
  });

  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Kabul Testleri",
    originalName,
    mediaType: "application/pdf",
    bytes,
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  if (flow.failed || flow.poll?.status !== "ACCEPTED") {
    return fail(correlationId, "T11_FIXTURE_NOT_ACCEPTED", await failEvidence({
      flow: flow.failed ?? { status: flow.poll?.status, observed: flow.poll?.observed },
    }));
  }
  const [authoritative, locatorResponse] = await Promise.all([
    readAcceptanceEvidence(client, ctx, flow.sessionId),
    resolvePrivateObjectLocator(client, ctx, flow.sessionId, "original"),
  ]);
  const locator = locatorResponse.body;
  if (!authoritative.ok || !locatorResponse.ok || typeof locator?.objectKey !== "string") {
    return fail(correlationId, "T11_PRIVATE_SURFACE_UNAVAILABLE", await failEvidence({
      evidence: redact(authoritative), locator: redact(locatorResponse),
    }));
  }

  const ocr = createS3Client({
    endpoint: ctx.config.s3.endpoint,
    bucket: ctx.config.s3.originalBucket,
    region: ctx.config.s3.region,
    credentials: ctx.config.iamRoles?.ocr,
    fetcher: ctx.config.s3.fetcher,
    signal: ctx.signal,
  });
  const head = await ocr.head(locator.objectKey);
  if (!head.ok) {
    return fail(correlationId, "T11_OBJECT_HEAD_DENIED", await failEvidence({
      head: maskedProviderResult(head),
    }));
  }
  const logs = await readCorrelatedLogs(ctx);
  if (!logs.ok || logs.records.length === 0) {
    return fail(correlationId, "T11_CORRELATED_LOGS_MISSING", await failEvidence({
      logStatus: logs.status, recordCount: logs.records.length,
    }));
  }

  const keyHits = markerHits(locator.objectKey, markers);
  const metadataHits = markerHits(JSON.stringify(head.metadata ?? {}), markers);
  const logHits = markerHits(JSON.stringify(logs.records), markers);
  const filenameUsedAsKey = locator.objectKey.includes(originalName);
  const totalFindings = keyHits.length + metadataHits.length + logHits.length
    + (filenameUsedAsKey ? 1 : 0);
  const scan = await ctx.writeEvidence("T-11-secret-scan", "secret-scan", {
    testId: "T-11", correlationId,
    markerDigests,
    surfaces: {
      objectKey: { scanned: true, findingCount: keyHits.length },
      customMetadata: { scanned: true, fieldCount: Object.keys(head.metadata ?? {}).length,
        findingCount: metadataHits.length },
      correlatedLogs: { scanned: true, recordCount: logs.records.length,
        findingCount: logHits.length },
    },
    filenameUsedAsObjectKey: filenameUsedAsKey,
    rawMarkersPersistedInEvidence: false,
  });
  const summary = await ctx.writeEvidence("T-11-finding-summary", "finding-summary", {
    testId: "T-11", correlationId,
    totalOpenFindings: totalFindings,
    legacyKeyMigrations: authoritative.body?.legacyKeyMigrations ?? null,
    originalSha256: flow.sha256,
    objectKeyDigest: sha256Hex(Buffer.from(locator.objectKey)),
    assertion: "synthetic personal-data markers are absent from physical key, custom metadata and correlated logs",
  });
  const evidence = [scan, summary];

  if (totalFindings !== 0) {
    return { result: "FAIL", correlationId, errorCode: "T11_PERSONAL_DATA_SURFACE_LEAK", evidence };
  }
  if (!authoritative.body?.legacyKeyMigrations
      || !Number.isSafeInteger(authoritative.body.legacyKeyMigrations.total)) {
    return { result: "FAIL", correlationId, errorCode: "T11_LEGACY_MIGRATION_COUNT_MISSING", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
