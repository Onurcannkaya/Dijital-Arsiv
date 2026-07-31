#!/usr/bin/env node
/**
 * F1.11 — Staging kabul koşusu ve değişmez kanıt çıktısı.
 *
 * Varsayılan yürütücü kümesi bilinçli olarak boştur. Gerçek yürütücüler yalnız
 * scripts/acceptance-executors altındaki, repoda sürümlenen bir modülden yüklenir.
 */

import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MAX_EVIDENCE_FILE_BYTES,
  TEST_CATALOG,
  buildEvidenceManifest,
  canonicalJson,
  missingCapabilities,
  resolveCapabilities,
  sha256Hex,
} from "./phase-one-acceptance-core.mjs";

const EXECUTOR_TIMEOUT_MS = 5 * 60 * 1000;
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;
const SENSITIVE_CONTENT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} zorunludur.`);
  return value.trim();
}

function parseInteger(name) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) ? value : null;
}

function parseApprovals() {
  try {
    const parsed = JSON.parse(process.env.ACCEPTANCE_APPROVALS_JSON ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function outPath() {
  const index = process.argv.indexOf("--out");
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : `outputs/acceptance/${requireEnv("ACCEPTANCE_RUN_ID")}/manifest.json`;
}

function isContained(parent, child) {
  const relation = relative(parent, child);
  return relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation);
}

async function loadExecutors() {
  const moduleName = process.env.ACCEPTANCE_EXECUTOR_MODULE?.trim();
  if (!moduleName) return {};
  const allowedRoot = resolve(process.cwd(), "scripts", "acceptance-executors");
  const modulePath = resolve(process.cwd(), moduleName);
  if (!isContained(allowedRoot, modulePath) || !modulePath.endsWith(".mjs")) {
    throw new Error("ACCEPTANCE_EXECUTOR_MODULE izin verilen dizinin dışında.");
  }
  const loaded = await import(pathToFileURL(modulePath).href);
  if (!loaded.executors || typeof loaded.executors !== "object") {
    throw new Error("Kabul yürütücü modülü `executors` nesnesi dışa aktarmalıdır.");
  }
  return loaded.executors;
}

function scopedConfig(test) {
  const config = {
    baseUrl: process.env.ACCEPTANCE_BASE_URL,
    environment: process.env.ACCEPTANCE_ENVIRONMENT,
  };
  if (test.requires.includes("s3") || test.requires.includes("providerLockProfile")
      || test.requires.includes("restoreDrill")) {
    config.s3 = {
      endpoint: process.env.ACCEPTANCE_S3_ENDPOINT,
      originalBucket: process.env.ACCEPTANCE_ORIGINAL_BUCKET,
      quarantineBucket: process.env.ACCEPTANCE_QUARANTINE_BUCKET,
      restoreBucket: process.env.ACCEPTANCE_RESTORE_BUCKET,
      lockProfile: process.env.ACCEPTANCE_LOCK_PROFILE,
    };
  }
  if (test.requires.includes("iamIdentities")) {
    config.identities = {
      viewer: process.env.ACCEPTANCE_VIEWER_IDENTITY,
      unauthorized: process.env.ACCEPTANCE_UNAUTHORIZED_IDENTITY,
    };
  }
  if (test.requires.includes("secondProvider")) {
    config.secondProvider = {
      endpoint: process.env.ACCEPTANCE_SECOND_S3_ENDPOINT,
      bucket: process.env.ACCEPTANCE_SECOND_BUCKET,
    };
  }
  if (test.requires.includes("logAccess")) config.logEndpoint = process.env.ACCEPTANCE_LOG_ENDPOINT;
  return Object.freeze(config);
}

function sensitiveValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value);
}

function assertNoSensitiveContent(text, secrets, file) {
  if (secrets.some((secret) => text.includes(secret)) || SENSITIVE_CONTENT.some((pattern) => pattern.test(text))) {
    throw new Error(`Kanıt dosyası sır taramasını geçemedi: ${file}`);
  }
}

async function collectEvidence(testId, descriptors, evidenceRoot, packageRoot, secrets) {
  if (!Array.isArray(descriptors)) return [];
  const records = [];
  for (const descriptor of descriptors) {
    const filePath = resolve(evidenceRoot, String(descriptor?.path ?? ""));
    if (!isContained(evidenceRoot, filePath) || !filePath.endsWith(".json")) {
      throw new Error("Kanıt dosyası güvenli koşu dizininde bir JSON olmalıdır.");
    }
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size < 2 || fileStat.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error("Kanıt dosyasının türü veya boyutu geçersiz.");
    }
    const bytes = await readFile(filePath);
    const text = bytes.toString("utf8");
    JSON.parse(text);
    assertNoSensitiveContent(text, secrets, filePath);
    records.push({
      id: descriptor.id,
      testId,
      kind: descriptor.kind,
      file: relative(packageRoot, filePath).split(sep).join("/"),
      sha256: sha256Hex(bytes),
      sizeBytes: fileStat.size,
      mediaType: "application/json",
    });
  }
  return records;
}

async function runWithTimeout(executor, input) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      executor({ ...input, signal: controller.signal }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("EXECUTOR_TIMEOUT"));
        }, EXECUTOR_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

const startedAt = new Date().toISOString();
const runId = requireEnv("ACCEPTANCE_RUN_ID");
const target = resolve(outPath());
const packageRoot = dirname(target);
const evidenceRoot = resolve(packageRoot, "evidence");
await mkdir(packageRoot, { recursive: true });
await mkdir(evidenceRoot);

const capabilities = resolveCapabilities(process.env);
const executors = await loadExecutors();
const evidenceFiles = [];
const results = [];
const secrets = sensitiveValues();

for (const test of TEST_CATALOG) {
  const missing = missingCapabilities(test, capabilities);
  const executor = executors[test.id];
  if (missing.length > 0) {
    results.push({ id: test.id, result: "BLOCKED", blockedOn: missing.sort(), errorCode: "CAPABILITY_MISSING" });
    continue;
  }
  if (typeof executor !== "function") {
    results.push({ id: test.id, result: "BLOCKED", blockedOn: ["EXECUTOR_NOT_CONFIGURED"], errorCode: "EXECUTOR_NOT_CONFIGURED" });
    continue;
  }
  const testStarted = Date.now();
  try {
    const outcome = await runWithTimeout(executor, {
      test: Object.freeze({ ...test }),
      capabilities: Object.freeze({ ...capabilities }),
      config: scopedConfig(test),
      evidenceDir: evidenceRoot,
      runId,
    });
    const records = await collectEvidence(test.id, outcome.evidence, evidenceRoot, packageRoot, secrets);
    evidenceFiles.push(...records);
    results.push({
      id: test.id,
      result: outcome.result,
      durationMs: Date.now() - testStarted,
      correlationId: outcome.correlationId ?? null,
      errorCode: outcome.errorCode ?? null,
      adrReference: outcome.adrReference ?? null,
      compensatingControl: outcome.compensatingControl ?? null,
      evidenceRefs: records.map((record) => record.id),
    });
  } catch {
    results.push({
      id: test.id,
      result: "FAIL",
      durationMs: Date.now() - testStarted,
      errorCode: "EXECUTOR_ERROR",
    });
  }
}

const finishedAt = new Date().toISOString();
const { manifest, digest } = buildEvidenceManifest({
  runId,
  gitCommit: requireEnv("ACCEPTANCE_GIT_COMMIT"),
  appVersion: process.env.ACCEPTANCE_APP_VERSION ?? null,
  schemaVersion: parseInteger("ACCEPTANCE_SCHEMA_VERSION"),
  environment: requireEnv("ACCEPTANCE_ENVIRONMENT"),
  adapterProfile: process.env.ACCEPTANCE_ADAPTER_PROFILE ?? null,
  initiatedBy: process.env.ACCEPTANCE_INITIATED_BY ?? "ci",
  startedAt,
  finishedAt,
  source: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflow: process.env.GITHUB_WORKFLOW_REF ?? null,
    runAttempt: parseInteger("GITHUB_RUN_ATTEMPT"),
  },
  context: { baseUrl: process.env.ACCEPTANCE_BASE_URL ?? "", ...capabilities },
  exitCriteria: {
    preflight: {
      result: process.env.ACCEPTANCE_PREFLIGHT_RESULT ?? "BLOCKED",
      evidenceDigest: process.env.ACCEPTANCE_PREFLIGHT_EVIDENCE_DIGEST ?? null,
    },
    phaseZero: {
      result: process.env.ACCEPTANCE_PHASE_ZERO_RESULT ?? "BLOCKED",
      evidenceDigest: process.env.ACCEPTANCE_PHASE_ZERO_EVIDENCE_DIGEST ?? null,
    },
    openCriticalFindings: parseInteger("ACCEPTANCE_OPEN_CRITICAL_FINDINGS"),
    openHighFindings: parseInteger("ACCEPTANCE_OPEN_HIGH_FINDINGS"),
  },
  approvals: parseApprovals(),
  results,
  evidenceFiles,
});

const serialized = canonicalJson(manifest);
await writeFile(target, serialized, { encoding: "utf8", flag: "wx" });
await writeFile(`${target}.sha256`, `${digest}  ${target.split(sep).at(-1)}\n`, { encoding: "utf8", flag: "wx" });

console.log(JSON.stringify({
  event: "acceptance.run-complete",
  runId,
  manifestPath: target,
  manifestDigest: digest,
  storedDigest: sha256Hex(serialized),
  technicalGate: manifest.technicalGate,
  releaseGate: manifest.releaseGate,
  blocked: results.filter((result) => result.result === "BLOCKED").map((result) => result.id),
}, null, 2));

process.exit(manifest.technicalGate.passed ? 0 : 1);
