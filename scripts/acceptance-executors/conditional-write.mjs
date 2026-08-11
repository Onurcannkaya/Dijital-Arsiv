/** T-01 ? Ayn? fiziksel anahtara ikinci ko?ullu yazma engellenir. */
import { randomUUID } from "node:crypto";

import { fail, failureEvidence } from "./flows.mjs";
import { sha256Hex } from "./fixtures.mjs";
import {
  createS3Client, isConditionalConflict, maskedProviderResult,
} from "./s3-contract.mjs";

const KINDS = ["operation", "integrity"];

export async function runConditionalWriteProtection(_client, ctx) {
  const correlationId = `${ctx.runId}:T-01`;
  const key = `acceptance/immutability/${ctx.runId}/${randomUUID()}.bin`;
  const keyDigest = sha256Hex(Buffer.from(key));
  const firstBytes = Buffer.from(`first:${ctx.runId}:${randomUUID()}`);
  const secondBytes = Buffer.from(`second:${ctx.runId}:${randomUUID()}`);
  const firstSha = sha256Hex(firstBytes);
  const secondSha = sha256Hex(secondBytes);
  const s3 = createS3Client({
    endpoint: ctx.config.s3?.endpoint,
    bucket: ctx.config.s3?.originalBucket,
    region: ctx.config.s3?.region,
    credentials: ctx.config.s3?.credentials,
    signal: ctx.signal,
    fetcher: ctx.config.s3?.fetcher,
  });
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-01", KINDS, {
    testId: "T-01", correlationId, keyDigest, firstSha, secondSha, ...detail,
  });

  const firstPut = await s3.putIfAbsent(key, firstBytes);
  if (!firstPut.ok) {
    return fail(correlationId, "T01_INITIAL_WRITE_FAILED", await failEvidence({
      initialWrite: maskedProviderResult(firstPut),
    }));
  }
  const [beforeHead, beforeGet] = await Promise.all([s3.head(key), s3.get(key)]);
  if (!beforeHead.ok || !beforeGet.ok || sha256Hex(beforeGet.bytes) !== firstSha) {
    return fail(correlationId, "T01_INITIAL_READBACK_FAILED", await failEvidence({
      beforeHead: maskedProviderResult(beforeHead),
      beforeGet: maskedProviderResult(beforeGet),
      readbackSha: beforeGet.ok ? sha256Hex(beforeGet.bytes) : null,
    }));
  }

  const secondPut = await s3.putIfAbsent(key, secondBytes);
  const [afterHead, afterGet] = await Promise.all([s3.head(key), s3.get(key)]);
  const afterSha = afterGet.ok ? sha256Hex(afterGet.bytes) : null;
  const operation = await ctx.writeEvidence("T-01-operation", "operation", {
    testId: "T-01", correlationId, keyDigest,
    initialWrite: maskedProviderResult(firstPut),
    conflictingWrite: maskedProviderResult(secondPut),
    providerConditionalRejection: isConditionalConflict(secondPut),
  });
  const unchanged = beforeHead.ok && afterHead.ok && afterGet.ok
    && beforeHead.byteSize === afterHead.byteSize
    && beforeGet.bytes.byteLength === afterGet.bytes.byteLength
    && afterSha === firstSha
    && afterSha !== secondSha
    && (beforeHead.versionId === null || afterHead.versionId === beforeHead.versionId);
  const integrity = await ctx.writeEvidence("T-01-integrity", "integrity", {
    testId: "T-01", correlationId, keyDigest,
    expectedSha256: firstSha,
    beforeSha256: sha256Hex(beforeGet.bytes),
    afterSha256: afterSha,
    beforeByteSize: beforeGet.bytes.byteLength,
    afterByteSize: afterGet.bytes.byteLength,
    before: maskedProviderResult(beforeHead),
    after: maskedProviderResult(afterHead),
    unchanged,
  });
  const evidence = [operation, integrity];

  if (!isConditionalConflict(secondPut)) {
    return { result: "FAIL", correlationId, errorCode: "T01_SECOND_WRITE_NOT_REJECTED", evidence };
  }
  if (!unchanged) {
    return { result: "FAIL", correlationId, errorCode: "T01_ORIGINAL_CHANGED", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
