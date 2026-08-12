/** T-07 ? Sa?lay?c?ya ?zg? de?i?mezlik, retention ve yasal bekletme kan?t?. */
import { randomUUID } from "node:crypto";

import { fail, failureEvidence } from "./flows.mjs";
import { sha256Hex } from "./fixtures.mjs";
import {
  createS3Client, isConditionalConflict, isProviderDenied, maskedProviderResult,
} from "./s3-contract.mjs";

export const R2_LOCK_PROFILE = "r2-bucket-lock-pilot-v1";
export const S3_LOCK_PROFILE = "s3-object-lock-compliance-v1";

const R2_KINDS = ["decision", "compensating-control", "integrity"];
const S3_KINDS = ["immutability-control", "integrity"];

function keyUnder(prefix, runId, label) {
  return `${String(prefix).replace(/\/+$/, "")}/acceptance/t07/${runId}/${label}-${randomUUID()}.bin`;
}

function sameInstant(left, right) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && leftTime === rightTime;
}

function clientFor(ctx, credentials) {
  return createS3Client({
    endpoint: ctx.config.s3.endpoint,
    bucket: ctx.config.s3.lockBucket,
    region: ctx.config.s3.region,
    credentials,
    signal: ctx.signal,
    fetcher: ctx.config.s3.fetcher,
    now: ctx.now,
  });
}

async function runR2Pilot(ctx, correlationId) {
  const writer = clientFor(ctx, ctx.config.s3.credentials);
  const probe = clientFor(ctx, ctx.config.s3.lockProbeCredentials);
  const lockedKey = keyUnder(ctx.config.s3.lockedPrefix, ctx.runId, "locked");
  const controlKey = keyUnder(ctx.config.s3.unlockedPrefix, ctx.runId, "control");
  const lockedKeyDigest = sha256Hex(Buffer.from(lockedKey));
  const controlKeyDigest = sha256Hex(Buffer.from(controlKey));
  const original = Buffer.from(`t07-r2-original:${ctx.runId}:${randomUUID()}`);
  const replacement = Buffer.from(`t07-r2-replacement:${ctx.runId}:${randomUUID()}`);
  const originalSha = sha256Hex(original);
  const replacementSha = sha256Hex(replacement);
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-07", R2_KINDS, {
    testId: "T-07", correlationId, profile: R2_LOCK_PROFILE,
    lockedKeyDigest, controlKeyDigest, ...detail,
  });

  // Yetkinin ger?ekten mevcut oldu?unu kilitsiz alanda kan?tlamadan 403'? kilit kan?t? sayma.
  const controlCreate = await probe.putIfAbsent(controlKey, original);
  const controlOverwrite = await probe.put(controlKey, replacement);
  const controlRead = await probe.get(controlKey);
  const controlDelete = await probe.delete(controlKey);
  const controlBaseline = controlCreate.ok && controlOverwrite.ok && controlRead.ok
    && sha256Hex(controlRead.bytes) === replacementSha && controlDelete.ok;
  if (!controlBaseline) {
    return fail(correlationId, "T07_R2_PROBE_BASELINE_FAILED", await failEvidence({
      controlCreate: maskedProviderResult(controlCreate),
      controlOverwrite: maskedProviderResult(controlOverwrite),
      controlRead: maskedProviderResult(controlRead),
      controlDelete: maskedProviderResult(controlDelete),
    }));
  }

  const initialWrite = await writer.putIfAbsent(lockedKey, original);
  const before = initialWrite.ok ? await writer.get(lockedKey) : initialWrite;
  if (!initialWrite.ok || !before.ok || sha256Hex(before.bytes) !== originalSha) {
    return fail(correlationId, "T07_R2_LOCKED_WRITE_FAILED", await failEvidence({
      initialWrite: maskedProviderResult(initialWrite),
      before: maskedProviderResult(before),
    }));
  }

  const overwrite = await probe.put(lockedKey, replacement);
  const deletion = await probe.delete(lockedKey);
  const after = await writer.get(lockedKey);
  const overwriteDenied = isProviderDenied(overwrite);
  const deleteDenied = isProviderDenied(deletion);
  const unchanged = after.ok && sha256Hex(after.bytes) === originalSha
    && after.bytes.byteLength === original.byteLength;

  const decision = await ctx.writeEvidence("T-07-decision", "decision", {
    testId: "T-07", correlationId, profile: R2_LOCK_PROFILE,
    adrReference: "ADR-016",
    objectLockAndLegalHold: "NOT_APPLICABLE",
    reason: "R2 bucket lock, S3 Object Lock ve legal hold ile e?de?er de?ildir.",
  });
  const compensation = await ctx.writeEvidence(
    "T-07-compensating-control", "compensating-control", {
      testId: "T-07", correlationId, lockedKeyDigest, controlKeyDigest,
      controlBaseline,
      lockedOverwrite: maskedProviderResult(overwrite),
      lockedDelete: maskedProviderResult(deletion),
      overwriteDenied,
      deleteDenied,
      result: overwriteDenied && deleteDenied && unchanged ? "PASS" : "FAIL",
    },
  );
  const integrity = await ctx.writeEvidence("T-07-integrity", "integrity", {
    testId: "T-07", correlationId, lockedKeyDigest,
    expectedSha256: originalSha,
    replacementSha256: replacementSha,
    finalSha256: after.ok ? sha256Hex(after.bytes) : null,
    expectedByteSize: original.byteLength,
    finalByteSize: after.ok ? after.bytes.byteLength : null,
    unchanged,
  });
  const evidence = [decision, compensation, integrity];

  if (!overwriteDenied || !deleteDenied) {
    return { result: "FAIL", correlationId, errorCode: "T07_R2_BUCKET_LOCK_BYPASSED", evidence };
  }
  if (!unchanged) {
    return { result: "FAIL", correlationId, errorCode: "T07_R2_LOCKED_OBJECT_CHANGED", evidence };
  }
  return {
    result: "NOT_APPLICABLE",
    correlationId,
    adrReference: "ADR-016",
    compensatingControl: { result: "PASS" },
    evidence,
  };
}

async function runS3Compliance(ctx, correlationId) {
  const writer = clientFor(ctx, ctx.config.s3.credentials);
  const retentionAdmin = clientFor(ctx, ctx.config.s3.retentionAdminCredentials);
  const retentionKey = keyUnder(ctx.config.s3.lockedPrefix, ctx.runId, "retention");
  const legalKey = keyUnder(ctx.config.s3.lockedPrefix, ctx.runId, "legal-hold");
  const retentionKeyDigest = sha256Hex(Buffer.from(retentionKey));
  const legalKeyDigest = sha256Hex(Buffer.from(legalKey));
  const original = Buffer.from(`t07-s3-retention:${ctx.runId}:${randomUUID()}`);
  const legalBytes = Buffer.from(`t07-s3-legal:${ctx.runId}:${randomUUID()}`);
  const replacement = Buffer.from(`t07-s3-replacement:${ctx.runId}:${randomUUID()}`);
  const originalSha = sha256Hex(original);
  const now = (ctx.now?.() ?? new Date()).getTime();
  const initialUntil = new Date(now + 24 * 60 * 60_000).toISOString();
  const shorterUntil = new Date(now + 12 * 60 * 60_000).toISOString();
  const extendedUntil = new Date(now + 48 * 60 * 60_000).toISOString();
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-07", S3_KINDS, {
    testId: "T-07", correlationId, profile: S3_LOCK_PROFILE,
    retentionKeyDigest, legalKeyDigest, ...detail,
  });

  const [versioning, lockConfig] = await Promise.all([
    retentionAdmin.getBucketVersioning(),
    retentionAdmin.getObjectLockConfiguration(),
  ]);
  if (versioning.versioningStatus !== "Enabled" || lockConfig.objectLockEnabled !== "Enabled") {
    return fail(correlationId, "T07_S3_LOCK_CONFIGURATION_INVALID", await failEvidence({
      versioning: maskedProviderResult(versioning),
      lockConfiguration: maskedProviderResult(lockConfig),
    }));
  }

  const initialWrite = await writer.putLocked(retentionKey, original, {
    mode: "COMPLIANCE", retainUntilDate: initialUntil,
  });
  if (!initialWrite.ok || !initialWrite.versionId) {
    return fail(correlationId, "T07_S3_COMPLIANCE_WRITE_FAILED", await failEvidence({
      initialWrite: maskedProviderResult(initialWrite),
    }));
  }
  const versionId = initialWrite.versionId;
  const initialRetention = await retentionAdmin.getRetention(retentionKey, versionId);
  const conditionalReplacement = await writer.putIfAbsent(retentionKey, replacement);
  const protectedDelete = await retentionAdmin.deleteVersion(retentionKey, versionId);
  const shorten = await retentionAdmin.putRetention(retentionKey, versionId, {
    mode: "COMPLIANCE", retainUntilDate: shorterUntil,
  });
  const extend = await retentionAdmin.putRetention(retentionKey, versionId, {
    mode: "COMPLIANCE", retainUntilDate: extendedUntil,
  });
  const finalRetention = await retentionAdmin.getRetention(retentionKey, versionId);
  const finalRead = await writer.get(retentionKey);

  const legalWrite = await writer.put(legalKey, legalBytes);
  if (!legalWrite.ok || !legalWrite.versionId) {
    return fail(correlationId, "T07_S3_LEGAL_HOLD_WRITE_FAILED", await failEvidence({
      legalWrite: maskedProviderResult(legalWrite),
    }));
  }
  const holdOn = await retentionAdmin.putLegalHold(legalKey, legalWrite.versionId, "ON");
  const holdStatus = await retentionAdmin.getLegalHold(legalKey, legalWrite.versionId);
  const heldDelete = await retentionAdmin.deleteVersion(legalKey, legalWrite.versionId);
  const holdOff = await retentionAdmin.putLegalHold(legalKey, legalWrite.versionId, "OFF");
  const releasedDelete = await retentionAdmin.deleteVersion(legalKey, legalWrite.versionId);

  const retentionValid = initialRetention.ok
    && initialRetention.retentionMode === "COMPLIANCE"
    && sameInstant(initialRetention.retentionUntilDate, initialUntil)
    && isConditionalConflict(conditionalReplacement)
    && isProviderDenied(protectedDelete)
    && isProviderDenied(shorten)
    && extend.ok
    && finalRetention.ok
    && finalRetention.retentionMode === "COMPLIANCE"
    && sameInstant(finalRetention.retentionUntilDate, extendedUntil);
  const legalHoldValid = holdOn.ok && holdStatus.legalHoldStatus === "ON"
    && isProviderDenied(heldDelete) && holdOff.ok && releasedDelete.ok;
  const unchanged = finalRead.ok && sha256Hex(finalRead.bytes) === originalSha
    && finalRead.bytes.byteLength === original.byteLength;

  const controls = await ctx.writeEvidence("T-07-immutability-control", "immutability-control", {
    testId: "T-07", correlationId, profile: S3_LOCK_PROFILE,
    retentionKeyDigest, legalKeyDigest,
    versioning: maskedProviderResult(versioning),
    lockConfiguration: maskedProviderResult(lockConfig),
    initialWrite: maskedProviderResult(initialWrite),
    initialRetention: maskedProviderResult(initialRetention),
    conditionalReplacement: maskedProviderResult(conditionalReplacement),
    protectedDelete: maskedProviderResult(protectedDelete),
    shorten: maskedProviderResult(shorten),
    extend: maskedProviderResult(extend),
    finalRetention: maskedProviderResult(finalRetention),
    holdOn: maskedProviderResult(holdOn),
    holdStatus: maskedProviderResult(holdStatus),
    heldDelete: maskedProviderResult(heldDelete),
    holdOff: maskedProviderResult(holdOff),
    releasedDelete: maskedProviderResult(releasedDelete),
    retentionValid,
    legalHoldValid,
  });
  const integrity = await ctx.writeEvidence("T-07-integrity", "integrity", {
    testId: "T-07", correlationId, retentionKeyDigest,
    expectedSha256: originalSha,
    finalSha256: finalRead.ok ? sha256Hex(finalRead.bytes) : null,
    expectedByteSize: original.byteLength,
    finalByteSize: finalRead.ok ? finalRead.bytes.byteLength : null,
    unchanged,
  });
  const evidence = [controls, integrity];

  if (!retentionValid) {
    return { result: "FAIL", correlationId, errorCode: "T07_S3_RETENTION_CONTROL_FAILED", evidence };
  }
  if (!legalHoldValid) {
    return { result: "FAIL", correlationId, errorCode: "T07_S3_LEGAL_HOLD_CONTROL_FAILED", evidence };
  }
  if (!unchanged) {
    return { result: "FAIL", correlationId, errorCode: "T07_S3_LOCKED_OBJECT_CHANGED", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}

export async function runProviderLockProfile(_client, ctx) {
  const correlationId = `${ctx.runId}:T-07`;
  if (ctx.config.s3?.lockProfile === R2_LOCK_PROFILE) {
    return runR2Pilot(ctx, correlationId);
  }
  if (ctx.config.s3?.lockProfile === S3_LOCK_PROFILE) {
    return runS3Compliance(ctx, correlationId);
  }
  return fail(correlationId, "T07_LOCK_PROFILE_UNSUPPORTED", []);
}
