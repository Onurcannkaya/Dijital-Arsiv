/** K-6 ? 2 GiB profilde d?rt oturum ? d?rt e?zamanl? par?a kaynak disiplini. */
import { randomUUID } from "node:crypto";
import { createSession, fail, failureEvidence, redact } from "./flows.mjs";
import { sha256Hex } from "./fixtures.mjs";
import { sleep } from "./contract.mjs";

const PROFILE_BYTES = 2 * 1024 * 1024 * 1024;
const EXPECTED_PART_BYTES = 16 * 1024 * 1024;
const SESSION_COUNT = 4;
const CONCURRENT_PARTS = 4;
const KINDS = ["performance", "resource-usage"];

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function readMetrics(ctx) {
  const endpoint = new URL(ctx.config.resourceMetricsEndpoint);
  endpoint.searchParams.set("correlationId", ctx.requestCorrelationId);
  const fetcher = ctx.config.resourceMetricsFetcher ?? fetch;
  let last = { ok: false, status: 0, body: null };
  for (let attempt = 0; attempt < (ctx.metricsAttempts ?? 12); attempt += 1) {
    const response = await fetcher(endpoint, {
      headers: { authorization: `Bearer ${ctx.config.resourceMetricsToken}` },
      signal: ctx.signal,
    });
    let body = null;
    try { body = await response.json(); } catch { /* fail-closed */ }
    last = { ok: response.ok, status: response.status, body };
    if (response.ok && Array.isArray(body?.samples) && body.samples.length >= 4) return last;
    await sleep(ctx.metricsIntervalMs ?? 5_000, ctx.signal);
  }
  return last;
}

export async function runMaximumProfileConcurrency(client, ctx) {
  const correlationId = `${ctx.runId}:K-6`;
  const profileBytes = ctx.profileBytes ?? PROFILE_BYTES;
  const sessionCount = ctx.sessionCount ?? SESSION_COUNT;
  const concurrentParts = ctx.concurrentParts ?? CONCURRENT_PARTS;
  const tag = `k6-${ctx.runId}-${randomUUID()}`;
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "K-6", KINDS, {
    testId: "K-6", correlationId, profileBytes, sessionCount, concurrentParts, ...detail,
  });

  const created = await Promise.all(Array.from({ length: sessionCount }, (_, index) =>
    createSession(client, {
      unit: ctx.config.unit ?? "Kabul Testleri",
      byteSize: profileBytes,
      mediaType: "application/pdf",
      originalName: `${tag}-${index + 1}.pdf`,
      idempotencyKey: `${tag}-${index + 1}`,
    })));
  const sessions = created.map((response) => response.body?.session);
  if (created.some((response) => !response.ok)
      || sessions.some((session) => !session?.id)) {
    return fail(correlationId, "K6_SESSION_CREATE_FAILED", await failEvidence({
      responses: created.map(redact),
    }));
  }
  const partSize = sessions[0].partSize;
  const expectedPartCount = sessions[0].expectedPartCount;
  if (!sessions.every((session) => session.multipart === true
      && session.partSize === partSize && session.expectedPartCount === expectedPartCount)
      || partSize !== (ctx.expectedPartBytes ?? EXPECTED_PART_BYTES)
      || expectedPartCount !== Math.ceil(profileBytes / partSize)) {
    return fail(correlationId, "K6_PROFILE_CONTRACT_INVALID", await failEvidence({
      partSize, expectedPartCount,
    }));
  }

  const bytes = new Uint8Array(partSize);
  for (let index = 0; index < bytes.length; index += 4096) bytes[index] = (index / 4096) % 251;
  const partSha = sha256Hex(bytes);
  let uploadedParts = 0;
  let rejectedParts = 0;
  let runnerPeakRss = process.memoryUsage().rss;

  for (let start = 1; start <= expectedPartCount; start += concurrentParts) {
    const partNumbers = Array.from(
      { length: Math.min(concurrentParts, expectedPartCount - start + 1) },
      (_, index) => start + index,
    );
    const responses = await Promise.all(sessions.flatMap((session) =>
      partNumbers.map((partNumber) => client.putPart(
        `/api/uploads/${session.id}/parts`,
        { partNumber, sha256: partSha, bytes },
      ))));
    uploadedParts += responses.filter((response) => response.ok).length;
    rejectedParts += responses.filter((response) => !response.ok).length;
    runnerPeakRss = Math.max(runnerPeakRss, process.memoryUsage().rss);
    if (responses.some((response) => !response.ok)) {
      return fail(correlationId, "K6_PART_UPLOAD_REJECTED", await failEvidence({
        batchStart: start, responses: responses.filter((response) => !response.ok).map(redact),
        uploadedParts, rejectedParts,
      }));
    }
  }

  const finalViews = await Promise.all(sessions.map((session) =>
    client.json("GET", `/api/uploads?id=${encodeURIComponent(session.id)}`)));
  const expectedUploads = expectedPartCount * sessionCount;
  const completeInventory = finalViews.every((response) =>
    response.ok
      && response.body?.session?.status === "UPLOADING"
      && response.body.session.completedParts?.length === expectedPartCount
      && response.body.session.missingParts?.length === 0);
  const metrics = await readMetrics(ctx);
  if (!metrics.ok || !Array.isArray(metrics.body?.samples)) {
    return fail(correlationId, "K6_RESOURCE_METRICS_MISSING", await failEvidence({
      metricsStatus: metrics.status, uploadedParts, expectedUploads,
    }));
  }
  const memoryLimit = Number(metrics.body.memoryLimitBytes);
  const memoryValues = metrics.body.samples.map((sample) => Number(sample.memoryBytes))
    .filter(Number.isFinite);
  if (!Number.isFinite(memoryLimit) || memoryLimit <= 0 || memoryValues.length < 4) {
    return fail(correlationId, "K6_RESOURCE_METRICS_INVALID", await failEvidence({
      sampleCount: memoryValues.length,
    }));
  }
  const midpoint = Math.floor(memoryValues.length / 2);
  const earlyP95 = percentile(memoryValues.slice(0, midpoint), 0.95);
  const lateP95 = percentile(memoryValues.slice(midpoint), 0.95);
  const peakMemory = Math.max(...memoryValues);
  const memoryGrowth = lateP95 - earlyP95;
  const headroomPass = peakMemory <= memoryLimit * 0.8;
  const nonLinearGrowthPass = memoryGrowth <= Math.max(partSize, memoryLimit * 0.1);

  const performance = await ctx.writeEvidence("K-6-performance", "performance", {
    testId: "K-6", correlationId,
    profileBytes, sessionCount, concurrentParts, partSize, expectedPartCount,
    expectedUploads, uploadedParts, rejectedParts,
    completeInventory,
    sessionsLeftForLifecycleExpiry: true,
  });
  const resource = await ctx.writeEvidence("K-6-resource-usage", "resource-usage", {
    testId: "K-6", correlationId,
    metricSource: metrics.body.source ?? "external-runtime-observability",
    sampleCount: memoryValues.length,
    memoryLimitBytes: memoryLimit,
    peakMemoryBytes: peakMemory,
    earlyP95MemoryBytes: earlyP95,
    lateP95MemoryBytes: lateP95,
    memoryGrowthBytes: memoryGrowth,
    headroomPass,
    nonLinearGrowthPass,
    runnerPeakRssBytesDiagnosticOnly: runnerPeakRss,
  });
  const evidence = [performance, resource];

  if (uploadedParts !== expectedUploads || rejectedParts !== 0 || !completeInventory) {
    return { result: "FAIL", correlationId, errorCode: "K6_UPLOAD_INVENTORY_INVALID", evidence };
  }
  if (!headroomPass) {
    return { result: "FAIL", correlationId, errorCode: "K6_RUNTIME_HEADROOM_EXCEEDED", evidence };
  }
  if (!nonLinearGrowthPass) {
    return { result: "FAIL", correlationId, errorCode: "K6_MEMORY_GROWTH_LINEAR", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
