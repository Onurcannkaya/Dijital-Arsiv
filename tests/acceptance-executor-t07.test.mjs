import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { resolveCapabilities } from "../scripts/phase-one-acceptance-core.mjs";
import {
  R2_LOCK_PROFILE,
  S3_LOCK_PROFILE,
  runProviderLockProfile,
} from "../scripts/acceptance-executors/provider-lock-profile.mjs";
import { fakeLockS3, testCredentials } from "./acceptance-fake-s3.mjs";

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "acceptance-t07-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function context(dir, s3, profile) {
  return {
    runId: "run-t07",
    signal: undefined,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    writeEvidence: evidenceWriter(dir),
    config: {
      s3: {
        endpoint: "https://s3.example",
        lockBucket: s3.bucket,
        lockedPrefix: s3.lockedPrefix,
        unlockedPrefix: s3.unlockedPrefix,
        lockProfile: profile,
        region: "eu-central-1",
        credentials: testCredentials("promotion"),
        lockProbeCredentials: testCredentials("lock-probe"),
        retentionAdminCredentials: testCredentials("retention-admin"),
        fetcher: s3.fetcher,
      },
    },
  };
}

test("T-07 R2 pilotu IAM reddini kilit sanmadan telafi kontrol?n? kan?tlar", async () => {
  await withDir(async (dir) => {
    const s3 = fakeLockS3({ profile: R2_LOCK_PROFILE });
    const outcome = await runProviderLockProfile(null, context(dir, s3, R2_LOCK_PROFILE));
    assert.equal(outcome.result, "NOT_APPLICABLE");
    assert.equal(outcome.adrReference, "ADR-016");
    assert.deepEqual(outcome.compensatingControl, { result: "PASS" });
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind), [
      "decision", "compensating-control", "integrity",
    ]);
    const compensation = JSON.parse(
      await readFile(join(dir, "T-07-compensating-control.json"), "utf8"),
    );
    assert.equal(compensation.controlBaseline, true);
    assert.equal(compensation.overwriteDenied, true);
    assert.equal(compensation.deleteDenied, true);
    assert.equal(compensation.result, "PASS");
    assert.equal("lockedKey" in compensation, false);
  });
});

test("T-07 R2 kilitsiz baz ?izgisi de reddediliyorsa yanl?? PASS ?retmez", async () => {
  await withDir(async (dir) => {
    const s3 = fakeLockS3({ profile: R2_LOCK_PROFILE, denyUnlockedMutations: true });
    const outcome = await runProviderLockProfile(null, context(dir, s3, R2_LOCK_PROFILE));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T07_R2_PROBE_BASELINE_FAILED");
  });
});

test("T-07 S3 profili compliance retention ve legal hold ya?am d?ng?s?n? ayr? kan?tlar", async () => {
  await withDir(async (dir) => {
    const s3 = fakeLockS3({ profile: S3_LOCK_PROFILE });
    const outcome = await runProviderLockProfile(null, context(dir, s3, S3_LOCK_PROFILE));
    assert.equal(outcome.result, "PASS");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind), [
      "immutability-control", "integrity",
    ]);
    const controls = JSON.parse(
      await readFile(join(dir, "T-07-immutability-control.json"), "utf8"),
    );
    assert.equal(controls.versioning.versioningStatus, "Enabled");
    assert.equal(controls.lockConfiguration.objectLockEnabled, "Enabled");
    assert.equal(controls.initialRetention.lockMode, "COMPLIANCE");
    assert.equal(controls.shorten.status, 403);
    assert.equal(controls.extend.status, 200);
    assert.equal(controls.holdStatus.legalHoldStatus, "ON");
    assert.equal(controls.heldDelete.status, 403);
    assert.equal(controls.releasedDelete.status, 204);
    assert.equal(controls.retentionValid, true);
    assert.equal(controls.legalHoldValid, true);
  });
});
test("T-07 yetene?i yaln?z tam ve tan?ml? sa?lay?c? profillerinde a??l?r", () => {
  const base = {
    ACCEPTANCE_S3_ENDPOINT: "https://s3.example",
    ACCEPTANCE_ORIGINAL_BUCKET: "original",
    ACCEPTANCE_QUARANTINE_BUCKET: "quarantine",
    ACCEPTANCE_S3_ACCESS_KEY_ID: "promotion",
    ACCEPTANCE_S3_SECRET_ACCESS_KEY: "promotion-secret",
    ACCEPTANCE_LOCK_BUCKET: "lock",
    ACCEPTANCE_LOCKED_PREFIX: "locked",
  };
  assert.equal(resolveCapabilities({
    ...base,
    ACCEPTANCE_LOCK_PROFILE: "unknown-profile",
  }).providerLockProfile, false);
  assert.equal(resolveCapabilities({
    ...base,
    ACCEPTANCE_LOCK_PROFILE: R2_LOCK_PROFILE,
    ACCEPTANCE_UNLOCKED_PREFIX: "unlocked",
    ACCEPTANCE_LOCK_PROBE_S3_ACCESS_KEY_ID: "probe",
    ACCEPTANCE_LOCK_PROBE_S3_SECRET_ACCESS_KEY: "probe-secret",
  }).providerLockProfile, true);
  assert.equal(resolveCapabilities({
    ...base,
    ACCEPTANCE_LOCK_PROFILE: S3_LOCK_PROFILE,
    ACCEPTANCE_RETENTION_ADMIN_S3_ACCESS_KEY_ID: "admin",
    ACCEPTANCE_RETENTION_ADMIN_S3_SECRET_ACCESS_KEY: "admin-secret",
  }).providerLockProfile, true);
});
