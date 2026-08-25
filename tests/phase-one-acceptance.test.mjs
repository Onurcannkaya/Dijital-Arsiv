/** F1.11 — Kabul kanıtı sözleşmesi ve kapı kuralları. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACCEPTANCE_CONTRACT_VERSION,
  RESULTS,
  TEST_CATALOG,
  TEST_CATALOG_DIGEST,
  buildEvidenceManifest,
  canonicalJson,
  evaluateGate,
  evaluateTechnicalGate,
  maskContext,
  missingCapabilities,
  resolveCapabilities,
} from "../scripts/phase-one-acceptance-core.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const digest = (character) => character.repeat(64);

function evidenceFor(test, kinds = test.evidenceKinds) {
  return kinds.map((kind, index) => ({
    id: `${test.id}-${kind}`,
    testId: test.id,
    kind,
    file: `evidence/${test.id}/${index}-${kind}.json`,
    sha256: digest(String((index % 9) + 1)),
    sizeBytes: 128 + index,
    mediaType: "application/json",
  }));
}

function passingFixture() {
  const evidenceFiles = TEST_CATALOG.flatMap((entry) => evidenceFor(entry));
  const results = TEST_CATALOG.map((entry, index) => ({
    id: entry.id,
    result: "PASS",
    durationMs: 100 + index,
    correlationId: `run-0001-${entry.id}`,
    evidenceRefs: evidenceFor(entry).map((evidence) => evidence.id),
  }));
  return {
    results,
    options: {
      metadata: {
        runId: "run-0001",
        gitCommit: "a".repeat(40),
        appVersion: "0.1.0",
        schemaVersion: 22,
        environment: "staging",
        adapterProfile: "r2-staging-v1",
        initiatedBy: "ci-service",
        startedAt: "2026-07-31T10:00:00.000Z",
        finishedAt: "2026-07-31T10:05:00.000Z",
      },
      evidenceFiles,
      exitCriteria: {
        preflight: { result: "PASS", evidenceDigest: digest("b") },
        phaseZero: { result: "PASS", evidenceDigest: digest("c") },
        openCriticalFindings: 0,
        openHighFindings: 0,
      },
      approvals: [
        { role: "BILGI_ISLEM", subjectId: "corp:it-approver", approvedAt: "2026-07-31T09:50:00.000Z", evidenceDigest: digest("d") },
        { role: "BILGI_GUVENLIGI", subjectId: "corp:security-approver", approvedAt: "2026-07-31T09:51:00.000Z", evidenceDigest: digest("e") },
        { role: "ARSIV", subjectId: "corp:archive-approver", approvedAt: "2026-07-31T09:52:00.000Z", evidenceDigest: digest("f") },
      ],
    },
  };
}

test("katalog 12 politika ve 7 kabul hattı testini ve kanıt türlerini kapsar", () => {
  assert.equal(TEST_CATALOG.length, 19);
  assert.equal(TEST_CATALOG.filter((entry) => entry.id.startsWith("T-")).length, 12);
  assert.equal(TEST_CATALOG.filter((entry) => entry.id.startsWith("K-")).length, 7);
  assert.match(TEST_CATALOG_DIGEST, /^[a-f0-9]{64}$/);
  for (const entry of TEST_CATALOG) {
    assert.ok(entry.title && entry.executor && entry.approver, `${entry.id} eksik alan`);
    assert.ok(entry.evidenceKinds.length >= 2, `${entry.id} kanıt türü eksik`);
  }
});

test("tüm testler kanıtları, çıkış ölçütleri ve onaylarıyla PASS ise kapı açılır", () => {
  const fixture = passingFixture();
  assert.deepEqual(evaluateGate(fixture.results, fixture.options), { passed: true, failures: [] });
});

test("kanıtsız PASS, eksik sonuç ve açık yüksek bulgu kapıyı kapatır", () => {
  const fixture = passingFixture();
  const withoutEvidence = structuredClone(fixture);
  withoutEvidence.results[0].evidenceRefs = [];
  assert.ok(evaluateGate(withoutEvidence.results, withoutEvidence.options).failures.includes("EVIDENCE_MISSING:T-01"));

  const missing = evaluateGate(fixture.results.filter((result) => result.id !== "K-3"), fixture.options);
  assert.ok(missing.failures.includes("MISSING:K-3"));

  const findings = structuredClone(fixture.options);
  findings.exitCriteria.openHighFindings = 1;
  assert.ok(evaluateGate(fixture.results, findings).failures.includes("EXIT_HIGH_FINDINGS_OPEN"));
});

test("FAIL/BLOCKED ve serbest biçimli hata mesajı kapıyı güvenli kapatır", () => {
  const fixture = passingFixture();
  const failed = fixture.results.map((result) => result.id === "T-02"
    ? { ...result, result: "FAIL", errorCode: "sağlayıcı token=abc" } : result);
  const gate = evaluateGate(failed, fixture.options);
  assert.ok(gate.failures.includes("FAIL:T-02"));
  assert.ok(gate.failures.includes("INVALID_ERROR_CODE:T-02"));

  const blocked = fixture.results.map((result) => result.id === "T-09"
    ? { ...result, result: "BLOCKED", errorCode: "CAPABILITY_MISSING" } : result);
  assert.ok(evaluateGate(blocked, fixture.options).failures.includes("BLOCKED:T-09"));
});

test("T-07 N/A yalnız ADR-016, telafi kontrolü, özel kanıt ve hukuk onayıyla geçer", () => {
  const fixture = passingFixture();
  const t07Kinds = ["decision", "compensating-control", "integrity"];
  fixture.options.evidenceFiles = fixture.options.evidenceFiles
    .filter((entry) => entry.testId !== "T-07")
    .concat(evidenceFor(TEST_CATALOG.find((entry) => entry.id === "T-07"), t07Kinds));
  fixture.results = fixture.results.map((result) => result.id === "T-07" ? {
    id: "T-07",
    result: "NOT_APPLICABLE",
    adrReference: "ADR-016",
    compensatingControl: { result: "PASS" },
    durationMs: 50,
    correlationId: "run-0001-T-07",
    evidenceRefs: t07Kinds.map((kind) => `T-07-${kind}`),
  } : result);

  const noLegal = evaluateGate(fixture.results, fixture.options);
  assert.ok(noLegal.failures.includes("APPROVAL_MISSING:HUKUK_KVKK"));
  fixture.options.approvals.push({
    role: "HUKUK_KVKK", subjectId: "corp:legal-approver",
    approvedAt: "2026-07-31T09:53:00.000Z", evidenceDigest: digest("9"),
  });
  assert.deepEqual(evaluateGate(fixture.results, fixture.options), { passed: true, failures: [] });

  fixture.results.find((result) => result.id === "T-07").adrReference = "ADR-999";
  assert.ok(evaluateGate(fixture.results, fixture.options).failures.includes("NOT_APPLICABLE_UNAUTHORIZED:T-07"));
});

test("kanıt yolu, fiziksel özet, bağlama ve artık dosya kuralları fail-closed çalışır", () => {
  const fixture = passingFixture();
  fixture.options.evidenceFiles[0].file = "../secret.json";
  fixture.options.evidenceFiles[1].sha256 = "not-a-digest";
  fixture.options.evidenceFiles.push({
    id: "orphan", testId: "T-01", kind: "operation", file: "evidence/orphan.json",
    sha256: digest("8"), sizeBytes: 32, mediaType: "application/json",
  });
  const gate = evaluateTechnicalGate(fixture.results, fixture.options);
  assert.ok(gate.failures.some((failure) => failure.startsWith("EVIDENCE_UNSAFE_PATH:")));
  assert.ok(gate.failures.some((failure) => failure.startsWith("EVIDENCE_INVALID_SHA:")));
  assert.ok(gate.failures.includes("EVIDENCE_UNREFERENCED:orphan"));
});

test("kurumsal onaylar teknik kapıdan ayrı ve değişmez kanıta bağlıdır", () => {
  const fixture = passingFixture();
  assert.equal(evaluateTechnicalGate(fixture.results, fixture.options).passed, true);
  fixture.options.approvals = [];
  const release = evaluateGate(fixture.results, fixture.options);
  assert.equal(release.passed, false);
  assert.ok(release.failures.includes("APPROVAL_MISSING:BILGI_ISLEM"));
});

test("yetenek çözümü HTTPS, sentetik staging ve fiziksel ayrım arar", () => {
  assert.equal(resolveCapabilities({}).staging, false);
  const stagingEnv = {
    ACCEPTANCE_BASE_URL: "https://staging.example",
    ARCHIVE_MIGRATION_TOKEN: "x".repeat(32),
    ACCEPTANCE_ENVIRONMENT: "staging",
    ACCEPTANCE_SYNTHETIC_ONLY: "enabled",
    ACCEPTANCE_UPLOADER_IDENTITY: "acceptance-uploader@sivas.bel.tr",
    ARCHIVE_ACCEPTANCE_TOKEN: "a".repeat(32),
  };
  const staged = resolveCapabilities(stagingEnv);
  assert.equal(staged.staging, true);
  assert.deepEqual(missingCapabilities(TEST_CATALOG.find((entry) => entry.id === "K-1"), staged), []);

  // Sentetik yükleyici kimliği olmadan staging yetenekleri BLOCKED kalır.
  const noIdentity = resolveCapabilities({ ...stagingEnv, ACCEPTANCE_UPLOADER_IDENTITY: "" });
  assert.equal(noIdentity.staging, false);

  const s3Base = {
    ...stagingEnv,
    ACCEPTANCE_S3_ENDPOINT: "https://s3.example",
    ACCEPTANCE_ORIGINAL_BUCKET: "original",
    ACCEPTANCE_QUARANTINE_BUCKET: "quarantine",
    ACCEPTANCE_S3_ACCESS_KEY_ID: "promotion",
    ACCEPTANCE_S3_SECRET_ACCESS_KEY: "promotion-secret",
  };
  assert.equal(resolveCapabilities({ ...s3Base, ACCEPTANCE_S3_SECRET_ACCESS_KEY: "" }).s3, false);
  assert.equal(resolveCapabilities(s3Base).s3, true);
  const iamBase = {
    ...s3Base,
    ACCEPTANCE_VIEWER_IDENTITY: "viewer@sivas.bel.tr",
    ACCEPTANCE_UNAUTHORIZED_IDENTITY: "none@sivas.bel.tr",
  };
  assert.equal(resolveCapabilities(iamBase).iamIdentities, false);
  const withIam = { ...iamBase };
  for (const role of ["VIEWER", "APPLICATION", "SCANNER", "OCR"]) {
    withIam[`ACCEPTANCE_${role}_S3_ACCESS_KEY_ID`] = role.toLowerCase();
    withIam[`ACCEPTANCE_${role}_S3_SECRET_ACCESS_KEY`] = `${role.toLowerCase()}-secret`;
  }
  assert.equal(resolveCapabilities(withIam).iamIdentities, true);

  const unsafe = resolveCapabilities({
    ACCEPTANCE_BASE_URL: "http://production.example",
    ARCHIVE_MIGRATION_TOKEN: "x".repeat(32),
    ACCEPTANCE_ENVIRONMENT: "production",
    ACCEPTANCE_SYNTHETIC_ONLY: "enabled",
  });
  assert.equal(unsafe.staging, false);
});

test("kanıt bağlamı sır, bucket değeri ve URL yolunu sızdırmaz", () => {
  const masked = maskContext({

    baseUrl: "https://staging.example/gizli/yol?token=abc",
    ARCHIVE_MIGRATION_TOKEN: "cok-gizli-token",
    staging: true,
    ACCEPTANCE_ORIGINAL_BUCKET: "arsiv-orijinal",
    missing: "",
  });
  assert.equal(masked.baseUrl, "https://staging.example");
  assert.equal(masked.ARCHIVE_MIGRATION_TOKEN, true);
  assert.equal(masked.ACCEPTANCE_ORIGINAL_BUCKET, true);
  assert.equal(masked.missing, false);
  assert.ok(!JSON.stringify(masked).includes("cok-gizli-token"));
  assert.ok(!JSON.stringify(masked).includes("arsiv-orijinal"));
});

test("v2 manifest maskeli, deterministik ve teknik/release kapılarını taşır", () => {
  const fixture = passingFixture();
  const input = {
    ...fixture.options.metadata,
    context: { baseUrl: "https://s.example/x", ARCHIVE_MIGRATION_TOKEN: "gizli", staging: true },
    source: { repository: "org/repo", workflow: "wf@main", runAttempt: 1 },
    results: fixture.results,
    evidenceFiles: fixture.options.evidenceFiles,
    exitCriteria: fixture.options.exitCriteria,
    approvals: fixture.options.approvals,
  };
  const first = buildEvidenceManifest(input);
  const second = buildEvidenceManifest({ ...input, results: [...input.results].reverse() });
  assert.equal(first.digest, second.digest);
  assert.equal(first.manifest.contractVersion, ACCEPTANCE_CONTRACT_VERSION);
  assert.equal(first.manifest.catalogDigest, TEST_CATALOG_DIGEST);
  assert.equal(first.manifest.technicalGate.passed, true);
  assert.equal(first.manifest.releaseGate.passed, true);
  assert.ok(!canonicalJson(first.manifest).includes("gizli"));
});

test("koşu betiği ve workflow tam kalite, preflight, kanıt ve attestation kapılarına bağlıdır", async () => {
  const [runner, workflow] = await Promise.all([
    read("scripts/run-phase-one-acceptance.mjs"),
    read(".github/workflows/phase-one-acceptance.yml"),
  ]);
  assert.match(runner, /EXECUTOR_NOT_CONFIGURED/);
  assert.match(runner, /flag: "wx"/);
  assert.match(runner, /process\.exit\(manifest\.technicalGate\.passed \? 0 : 1\)/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment: phase-one-acceptance/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /scripts\/verify-deployment\.mjs/);
  assert.match(workflow, /scripts\/verify-phase-zero-evidence\.mjs/);
  assert.match(workflow, /gh attestation verify/);
  assert.match(workflow, /schema_version=\$\{p\.schemaVersion\}/);
  assert.match(workflow, /ACCEPTANCE_SCHEMA_VERSION: \$\{\{ steps\.preflight\.outputs\.schema_version \}\}/);
  assert.doesNotMatch(workflow, /ACCEPTANCE_SCHEMA_VERSION: \$\{\{ vars\./);
  assert.match(workflow, /actions\/attest@/);
  assert.match(workflow, /github\.run_attempt/);
  for (const value of RESULTS) assert.equal(typeof value, "string");
});
