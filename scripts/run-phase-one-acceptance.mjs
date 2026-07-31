#!/usr/bin/env node
/**
 * F1.11 — Staging kabul koşusu ve maskeli kanıt çıktısı.
 *
 * Koşu, yalnız gerekli yetenekleri yapılandırılmış testleri gerçek staging
 * ortamında yürütür; ön koşulu eksik testleri `BLOCKED` işaretler. Kanıt
 * manifesti değişmez `run_id` ile yazılır; manifest özeti paket DIŞINA
 * (yedek kataloğu/değişmez kayıt) verilmelidir. Kod var olması kabul kanıtı
 * DEĞİLDİR: gerçek staging olmadan koşu kapıyı KAPALI raporlar (BLOCKED).
 *
 * Kullanım:
 *   node scripts/run-phase-one-acceptance.mjs [--out <dosya>]
 * Zorunlu ortam:
 *   ACCEPTANCE_RUN_ID, ACCEPTANCE_GIT_COMMIT, ACCEPTANCE_ENVIRONMENT
 * İsteğe bağlı yetenek değişkenleri: resolveCapabilities'e bakınız.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  TEST_CATALOG,
  buildEvidenceManifest,
  canonicalJson,
  evaluateGate,
  missingCapabilities,
  resolveCapabilities,
  sha256Hex,
} from "./phase-one-acceptance-core.mjs";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} zorunludur.`);
  return value.trim();
}

function outPath() {
  const index = process.argv.indexOf("--out");
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : `outputs/acceptance/${requireEnv("ACCEPTANCE_RUN_ID")}.json`;
}

/**
 * Staging yürütücüleri altyapı hazır olduğunda bu haritaya eklenir. Bir test
 * hem yetenekleri hazır hem yürütücüsü tanımlıysa çalışır; yürütücüsü yoksa
 * `BLOCKED` kalır. Kanıt uydurmamak için varsayılan harita boştur.
 */
const EXECUTORS = {};

const startedAt = new Date().toISOString();
const runId = requireEnv("ACCEPTANCE_RUN_ID");
const capabilities = resolveCapabilities(process.env);
const evidenceFiles = [];
const results = [];

for (const test of TEST_CATALOG) {
  const missing = missingCapabilities(test, capabilities);
  const executor = EXECUTORS[test.id];
  if (missing.length > 0) {
    results.push({ id: test.id, result: "BLOCKED", blockedOn: missing.sort() });
    continue;
  }
  if (!executor) {
    results.push({ id: test.id, result: "BLOCKED", blockedOn: ["EXECUTOR_NOT_CONFIGURED"] });
    continue;
  }
  const testStarted = Date.now();
  try {
    const outcome = await executor({ capabilities, env: process.env });
    results.push({
      id: test.id,
      result: outcome.result,
      durationMs: Date.now() - testStarted,
      correlationId: outcome.correlationId ?? null,
      errorCode: outcome.errorCode ?? null,
      adrReference: outcome.adrReference ?? null,
    });
    for (const file of outcome.evidenceFiles ?? []) evidenceFiles.push(file);
  } catch (error) {
    results.push({
      id: test.id,
      result: "FAIL",
      durationMs: Date.now() - testStarted,
      errorCode: error instanceof Error ? error.message.slice(0, 200) : "EXECUTOR_ERROR",
    });
  }
}

const { manifest, digest } = buildEvidenceManifest({
  runId,
  gitCommit: requireEnv("ACCEPTANCE_GIT_COMMIT"),
  appVersion: process.env.ACCEPTANCE_APP_VERSION ?? null,
  schemaVersion: process.env.ACCEPTANCE_SCHEMA_VERSION
    ? Number(process.env.ACCEPTANCE_SCHEMA_VERSION) : null,
  environment: requireEnv("ACCEPTANCE_ENVIRONMENT"),
  adapterProfile: process.env.ACCEPTANCE_ADAPTER_PROFILE ?? null,
  initiatedBy: process.env.ACCEPTANCE_INITIATED_BY ?? "ci",
  startedAt,
  finishedAt: new Date().toISOString(),
  context: {
    baseUrl: process.env.ACCEPTANCE_BASE_URL ?? "",
    ...capabilities,
  },
  results,
  evidenceFiles,
});

const target = outPath();
await mkdir(dirname(target), { recursive: true });
const serialized = canonicalJson(manifest);
await writeFile(target, serialized, "utf8");

const gate = evaluateGate(results);
console.log(JSON.stringify({
  event: "acceptance.run-complete",
  runId,
  manifestPath: target,
  // Bu özet paket dışı güven köküne kaydedilmelidir (F1.10 doğrulaması).
  manifestDigest: digest,
  storedDigest: sha256Hex(serialized),
  gate,
  blocked: results.filter((result) => result.result === "BLOCKED").map((result) => result.id),
}, null, 2));

// Kapı kapalıysa (FAIL/BLOCKED/eksik) CI işi kırmızı olur. Gerçek staging
// kanıtı toplanana kadar bu beklenen ve dürüst sonuçtur.
process.exit(gate.passed ? 0 : 1);
