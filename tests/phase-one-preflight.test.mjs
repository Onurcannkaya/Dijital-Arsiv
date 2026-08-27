import assert from "node:assert/strict";
import test from "node:test";

import { TEST_CATALOG } from "../scripts/phase-one-acceptance-core.mjs";
import { validatePhaseOnePreflight } from "../scripts/phase-one-preflight.mjs";

function fixture() {
  const env = {
    ACCEPTANCE_OPEN_CRITICAL_FINDINGS: "0",
    ACCEPTANCE_OPEN_HIGH_FINDINGS: "0",
    ACCEPTANCE_ADAPTER_PROFILE: "minio-onprem-v1",
    ACCEPTANCE_UPLOADER_UNIT: "Kabul Testleri",
    ACCEPTANCE_PRODUCTION_GUARD: "confirmed-non-production",
    ACCEPTANCE_BASE_URL: "https://archive-staging.example.test",
    ACCEPTANCE_PRODUCTION_BASE_URL: "https://archive.example.test",
    ARCHIVE_ACCEPTANCE_TOKEN: "a".repeat(32),
    ACCEPTANCE_PROXY_TOKEN: "b".repeat(32),
    ACCEPTANCE_LOG_TOKEN: "c".repeat(32),
    ACCEPTANCE_RESOURCE_METRICS_TOKEN: "d".repeat(32),
    ACCEPTANCE_UPLOADER_IDENTITY: "uploader@example.test",
    ACCEPTANCE_VIEWER_IDENTITY: "viewer@example.test",
    ACCEPTANCE_UNAUTHORIZED_IDENTITY: "outside@example.test",
  };
  for (const [index, role] of ["VIEWER", "APPLICATION", "SCANNER", "OCR"].entries()) {
    env[`ACCEPTANCE_${role}_S3_ACCESS_KEY_ID`] = `role-${index}`;
    env[`ACCEPTANCE_${role}_S3_SECRET_ACCESS_KEY`] = String(index).repeat(32);
  }
  const capabilities = Object.fromEntries([
    "staging", "s3", "iamIdentities", "providerLockProfile", "restoreDrill",
    "secondProvider", "logAccess", "faultInjection", "largeFixtures",
  ].map((name) => [name, true]));
  return { env, capabilities, executors: TEST_CATALOG.map((entry) => entry.id) };
}

test("19 yürütücü ve tüm canlı yetenekler varsa sıkı staging ön kontrolü geçer", () => {
  const input = fixture();
  assert.deepEqual(validatePhaseOnePreflight(input.env, input.capabilities, input.executors), {
    ok: true,
    failures: [],
  });
});

test("BLOCKED üretecek eksik, üretim hedefi veya sahte IAM ayrımı koşudan önce reddedilir", () => {
  const input = fixture();
  input.capabilities.largeFixtures = false;
  input.env.ACCEPTANCE_PRODUCTION_BASE_URL = input.env.ACCEPTANCE_BASE_URL;
  input.env.ACCEPTANCE_OCR_S3_ACCESS_KEY_ID = input.env.ACCEPTANCE_SCANNER_S3_ACCESS_KEY_ID;
  input.env.ACCEPTANCE_OCR_S3_SECRET_ACCESS_KEY = "short";
  input.executors.pop();
  const result = validatePhaseOnePreflight(input.env, input.capabilities, input.executors);
  assert.ok(result.failures.includes("CAPABILITY_MISSING:largeFixtures"));
  assert.ok(result.failures.includes("STAGING_EQUALS_PRODUCTION"));
  assert.ok(result.failures.includes("IAM_ROLES_NOT_DISTINCT:ACCESS_KEY_ID"));
  assert.ok(result.failures.includes("IAM_ROLE_SECRET_INVALID:OCR"));
  assert.match(result.failures.find((entry) => entry.startsWith("EXECUTOR_MISSING:")) ?? "", /^EXECUTOR_MISSING:/);
});
