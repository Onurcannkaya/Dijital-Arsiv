/**
 * F1.11 — Kabul kanıtı sözleşmesi ve kapı kuralları.
 *
 * Kanıt rehberi §2/§8: 19 testin tamamı sonuçlandırılmalı; uygulanabilir olanlar
 * PASS, yalnız T-07 yetkili ADR ile NOT_APPLICABLE olabilir; FAIL/BLOCKED/eksik
 * kapıyı kapatır. Kanıt manifesti maskeli olmalı ve deterministik özet üretmeli.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RESULTS,
  TEST_CATALOG,
  buildEvidenceManifest,
  canonicalJson,
  evaluateGate,
  maskContext,
  missingCapabilities,
  resolveCapabilities,
} from "../scripts/phase-one-acceptance-core.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function allPass() {
  return TEST_CATALOG.map((test) => ({ id: test.id, result: "PASS" }));
}

test("katalog 12 politika ve 7 kabul hattı testini kapsar", () => {
  assert.equal(TEST_CATALOG.length, 19);
  const policy = TEST_CATALOG.filter((entry) => entry.id.startsWith("T-"));
  const pipeline = TEST_CATALOG.filter((entry) => entry.id.startsWith("K-"));
  assert.equal(policy.length, 12);
  assert.equal(pipeline.length, 7);
  for (const entry of TEST_CATALOG) {
    assert.ok(entry.title && entry.executor && entry.approver, `${entry.id} eksik alan`);
  }
});

test("tüm testler PASS ise kapı açılır", () => {
  const gate = evaluateGate(allPass());
  assert.deepEqual(gate, { passed: true, failures: [] });
});

test("eksik, FAIL veya BLOCKED sonuç kapıyı kapatır", () => {
  const missing = evaluateGate(allPass().filter((result) => result.id !== "K-3"));
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.includes("MISSING:K-3"));

  const failed = evaluateGate(allPass().map((result) =>
    result.id === "T-02" ? { ...result, result: "FAIL" } : result));
  assert.ok(failed.failures.includes("FAIL:T-02"));

  const blocked = evaluateGate(allPass().map((result) =>
    result.id === "T-09" ? { ...result, result: "BLOCKED" } : result));
  assert.ok(blocked.failures.includes("BLOCKED:T-09"));
});

test("NOT_APPLICABLE yalnız T-07 için ve yetkili ADR referansıyla geçerlidir", () => {
  const authorized = evaluateGate(allPass().map((result) =>
    result.id === "T-07" ? { id: "T-07", result: "NOT_APPLICABLE", adrReference: "ADR-016" } : result));
  assert.deepEqual(authorized, { passed: true, failures: [] });

  const noAdr = evaluateGate(allPass().map((result) =>
    result.id === "T-07" ? { id: "T-07", result: "NOT_APPLICABLE" } : result));
  assert.ok(noAdr.failures.includes("NOT_APPLICABLE_UNAUTHORIZED:T-07"));

  // Başka bir testte NOT_APPLICABLE kabul edilmez.
  const wrongTest = evaluateGate(allPass().map((result) =>
    result.id === "T-05" ? { id: "T-05", result: "NOT_APPLICABLE", adrReference: "ADR-016" } : result));
  assert.ok(wrongTest.failures.includes("NOT_APPLICABLE_UNAUTHORIZED:T-05"));
});

test("mükerrer ve bilinmeyen sonuç reddedilir", () => {
  const duplicate = evaluateGate([...allPass(), { id: "T-01", result: "PASS" }]);
  assert.ok(duplicate.failures.includes("DUPLICATE_RESULT"));
  const unknown = evaluateGate([...allPass(), { id: "T-99", result: "PASS" }]);
  assert.ok(unknown.failures.includes("UNKNOWN_TEST:T-99"));
});

test("yetenek çözümü eksik ön koşulları BLOCKED yapar", () => {
  const empty = resolveCapabilities({});
  assert.equal(empty.staging, false);
  assert.deepEqual(missingCapabilities(TEST_CATALOG.find((t) => t.id === "T-02"), empty), ["staging"]);

  const staged = resolveCapabilities({
    ACCEPTANCE_BASE_URL: "https://staging.example",
    ARCHIVE_MIGRATION_TOKEN: "x".repeat(32),
  });
  assert.equal(staged.staging, true);
  assert.deepEqual(missingCapabilities(TEST_CATALOG.find((t) => t.id === "K-1"), staged), []);
  // T-10 ikinci sağlayıcı ister; yalnız staging yetmez.
  assert.deepEqual(missingCapabilities(TEST_CATALOG.find((t) => t.id === "T-10"), staged), ["secondProvider"]);
});

test("kanıt bağlamı sır ve URL yolu sızdırmaz", () => {
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
  const serialized = JSON.stringify(masked);
  assert.ok(!serialized.includes("cok-gizli-token"));
  assert.ok(!serialized.includes("arsiv-orijinal"));
  assert.ok(!serialized.includes("/gizli/yol"));
});

test("kanıt manifesti maskeli, deterministik ve kapı sonucunu taşır", () => {
  const input = {
    runId: "run-1", gitCommit: "a".repeat(40), appVersion: "0.1.0", schemaVersion: 22,
    environment: "staging", adapterProfile: "r2-staging", initiatedBy: "ci",
    startedAt: "2026-07-31T10:00:00.000Z", finishedAt: "2026-07-31T10:05:00.000Z",
    context: { baseUrl: "https://s.example/x", ARCHIVE_MIGRATION_TOKEN: "gizli", staging: true },
    results: allPass(),
    evidenceFiles: [{ file: "b.json", sha256: "b".repeat(64) }, { file: "a.json", sha256: "a".repeat(64) }],
  };
  const first = buildEvidenceManifest(input);
  const second = buildEvidenceManifest({ ...input, results: [...input.results].reverse() });
  assert.equal(first.digest, second.digest, "sonuç sırası manifesti değiştirmemeli");
  assert.equal(first.manifest.gate.passed, true);
  assert.equal(first.manifest.results[0].id, "K-1", "sonuçlar kimliğe göre sıralı");
  assert.equal(first.manifest.evidenceFiles[0].file, "a.json", "kanıt dosyaları sıralı");
  assert.ok(first.manifest.results.every((result) => result.title && result.executor));
  assert.ok(!canonicalJson(first.manifest).includes("gizli"));
});

test("koşu betiği ve workflow kanıt kapısına bağlıdır", async () => {
  const [runner, workflow] = await Promise.all([
    read("scripts/run-phase-one-acceptance.mjs"),
    read(".github/workflows/phase-one-acceptance.yml"),
  ]);
  // Kod var olması kabul değildir: yürütücüsü olmayan test BLOCKED kalır.
  assert.match(runner, /EXECUTOR_NOT_CONFIGURED/);
  assert.match(runner, /process\.exit\(gate\.passed \? 0 : 1\)/);
  // Manifest özeti paket dışına verilmelidir.
  assert.match(runner, /manifestDigest/);
  // Workflow yalnız kontrollü tetiklenir ve korumalı ortam kapısı kullanır.
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment: phase-one-acceptance/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.match(workflow, /upload-artifact/);
  for (const value of RESULTS) assert.ok(typeof value === "string");
});
