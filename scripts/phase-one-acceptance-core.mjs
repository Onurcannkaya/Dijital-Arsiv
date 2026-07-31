/**
 * F1.11 — Kabul koşusu kanıt sözleşmesinin saf çekirdeği.
 *
 * Bu modül ağ/dosya erişimi yapmaz. Gerçek kanıt dosyalarının okunması ve
 * özetlenmesi koşu betiğinin sorumluluğundadır; kapı yalnız doğrulanmış kayıtları
 * kabul eder.
 */

import { createHash } from "node:crypto";

export const ACCEPTANCE_CONTRACT_VERSION = 2;
export const RESULTS = Object.freeze(["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"]);
export const MAX_EVIDENCE_FILE_BYTES = 5 * 1024 * 1024;

export const TEST_CATALOG = Object.freeze([
  { id: "T-01", title: "Aynı anahtara ikinci yazma engellenir", executor: "Yazılım Geliştirme", approver: "Bilgi Güvenliği", requires: ["s3"], evidenceKinds: ["operation", "integrity"] },
  { id: "T-02", title: "Asıl SHA yazma sonrası doğrulanır", executor: "Yazılım Geliştirme", approver: "Bilgi Güvenliği + Arşiv", requires: ["staging"], evidenceKinds: ["receipt", "integrity"] },
  { id: "T-03", title: "Asıl değişmeden türev üretilir", executor: "Yazılım Geliştirme", approver: "Arşiv + Bilgi Güvenliği", requires: ["staging"], evidenceKinds: ["inventory", "integrity"] },
  { id: "T-04", title: "Kullanıcı bucket anahtarı alamaz", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"], evidenceKinds: ["access-denial", "secret-scan"] },
  { id: "T-05", title: "Süresi dolan görüntüleme bileti çalışmaz", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"], evidenceKinds: ["access-denial", "audit"] },
  { id: "T-06", title: "Yetkisiz rol aslı okuyamaz veya silemez", executor: "Bilgi Güvenliği", approver: "Bilgi İşlem yöneticisi", requires: ["iamIdentities"], evidenceKinds: ["access-denial", "integrity"] },
  { id: "T-07", title: "Sürümleme/Object Lock ve yasal bekletme", executor: "Depolama İşletimi + Bilgi Güvenliği", approver: "Arşiv + Hukuk/KVKK + Bilgi İşlem", requires: ["providerLockProfile"], evidenceKinds: ["immutability-control", "integrity"] },
  { id: "T-08", title: "Bütünlük taraması uyuşmazlığı yakalar", executor: "Kalite Güvence", approver: "Bilgi Güvenliği + Depolama İşletimi", requires: ["staging", "s3"], evidenceKinds: ["finding", "alarm"] },
  { id: "T-09", title: "Belge bağlamıyla yedekten geri yüklenir", executor: "Yedekleme/Depolama İşletimi", approver: "Arşiv + Bilgi İşlem yöneticisi", requires: ["restoreDrill"], evidenceKinds: ["restore", "integrity"] },
  { id: "T-10", title: "Sağlayıcı taşınabilirlik manifesti doğrulanır", executor: "Depolama İşletimi", approver: "Bilgi Güvenliği + Arşiv", requires: ["secondProvider"], evidenceKinds: ["portability", "integrity"] },
  { id: "T-11", title: "Anahtar ve erişim logunda kişisel veri yoktur", executor: "Kalite Güvence + Veri Koruma", approver: "Hukuk/KVKK + Bilgi Güvenliği", requires: ["staging", "logAccess"], evidenceKinds: ["secret-scan", "finding-summary"] },
  { id: "T-12", title: "İki yönlü uzlaştırma rapor üretir", executor: "Kalite Güvence", approver: "Depolama İşletimi + Arşiv", requires: ["staging", "s3"], evidenceKinds: ["reconciliation", "finding"] },
  { id: "K-1", title: "MIME/magic-byte uyuşmazlığı reddedilir", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"], evidenceKinds: ["validation", "absence"] },
  { id: "K-2", title: "EICAR karantinada reddedilir", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"], evidenceKinds: ["malware-scan", "absence"] },
  { id: "K-3", title: "Multipart kesinti sonrası sürer", executor: "Kalite Güvence", approver: "Yazılım Geliştirme", requires: ["staging"], evidenceKinds: ["multipart", "inventory"] },
  { id: "K-4", title: "Karantina normal rolle okunamaz", executor: "Bilgi Güvenliği", approver: "Bilgi İşlem yöneticisi", requires: ["iamIdentities"], evidenceKinds: ["access-denial", "audit"] },
  { id: "K-5", title: "Terfi sonrası DB hatası aslı silmez", executor: "Kalite Güvence", approver: "Arşiv", requires: ["faultInjection"], evidenceKinds: ["fault-injection", "reconciliation"] },
  { id: "K-6", title: "Azami profil eşzamanlı yükleme bellek disiplini", executor: "Performans/Kalite Güvence", approver: "Bilgi İşlem", requires: ["staging", "largeFixtures"], evidenceKinds: ["performance", "resource-usage"] },
  { id: "K-7", title: "Mükerrer SHA yeni belge/asıl/OCR üretmez", executor: "Kalite Güvence", approver: "Bilgi Güvenliği", requires: ["staging"], evidenceKinds: ["deduplication", "absence"] },
]);

const TEST_IDS = new Set(TEST_CATALOG.map((test) => test.id));
const SAFE_OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,127}$/;
const SAFE_CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const REQUIRED_APPROVAL_ROLES = Object.freeze(["BILGI_ISLEM", "BILGI_GUVENLIGI", "ARSIV"]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const TEST_CATALOG_DIGEST = sha256Hex(canonicalJson(TEST_CATALOG));

function hasText(env, name) {
  return typeof env[name] === "string" && env[name].trim().length > 0;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Ortam değişkenlerinden yalnız güvenli kabul topolojisinin yeteneklerini çözer. */
export function resolveCapabilities(env) {
  const staging = isHttpsUrl(env.ACCEPTANCE_BASE_URL) && hasText(env, "ARCHIVE_MIGRATION_TOKEN")
    && env.ACCEPTANCE_ENVIRONMENT === "staging" && env.ACCEPTANCE_SYNTHETIC_ONLY === "enabled";
  const s3 = isHttpsUrl(env.ACCEPTANCE_S3_ENDPOINT) && hasText(env, "ACCEPTANCE_ORIGINAL_BUCKET")
    && hasText(env, "ACCEPTANCE_QUARANTINE_BUCKET")
    && env.ACCEPTANCE_ORIGINAL_BUCKET !== env.ACCEPTANCE_QUARANTINE_BUCKET;
  return {
    staging,
    s3,
    iamIdentities: staging && hasText(env, "ACCEPTANCE_VIEWER_IDENTITY")
      && hasText(env, "ACCEPTANCE_UNAUTHORIZED_IDENTITY")
      && env.ACCEPTANCE_VIEWER_IDENTITY !== env.ACCEPTANCE_UNAUTHORIZED_IDENTITY,
    providerLockProfile: s3 && hasText(env, "ACCEPTANCE_LOCK_PROFILE"),
    restoreDrill: s3 && hasText(env, "ACCEPTANCE_RESTORE_BUCKET")
      && env.ACCEPTANCE_RESTORE_BUCKET !== env.ACCEPTANCE_ORIGINAL_BUCKET,
    secondProvider: isHttpsUrl(env.ACCEPTANCE_SECOND_S3_ENDPOINT)
      && hasText(env, "ACCEPTANCE_SECOND_BUCKET")
      && env.ACCEPTANCE_SECOND_S3_ENDPOINT !== env.ACCEPTANCE_S3_ENDPOINT,
    logAccess: staging && isHttpsUrl(env.ACCEPTANCE_LOG_ENDPOINT),
    faultInjection: staging && env.ACCEPTANCE_FAULT_INJECTION === "enabled"
      && env.ACCEPTANCE_PRODUCTION_GUARD === "confirmed-non-production",
    largeFixtures: staging && env.ACCEPTANCE_LARGE_FIXTURES === "enabled",
  };
}

export function missingCapabilities(test, capabilities) {
  return (test.requires ?? []).filter((requirement) => !capabilities[requirement]);
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function safeRelativeEvidencePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 240) return false;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && value.endsWith(".json");
}

function validateMetadata(metadata, failures) {
  if (!metadata || typeof metadata !== "object") {
    failures.push("METADATA_MISSING");
    return;
  }
  if (!SAFE_OPAQUE.test(String(metadata.runId ?? ""))) failures.push("METADATA_INVALID:runId");
  if (!GIT_SHA.test(String(metadata.gitCommit ?? ""))) failures.push("METADATA_INVALID:gitCommit");
  if (!SAFE_OPAQUE.test(String(metadata.appVersion ?? ""))) failures.push("METADATA_INVALID:appVersion");
  if (!Number.isSafeInteger(metadata.schemaVersion) || metadata.schemaVersion < 1) failures.push("METADATA_INVALID:schemaVersion");
  if (metadata.environment !== "staging") failures.push("METADATA_INVALID:environment");
  if (!SAFE_OPAQUE.test(String(metadata.adapterProfile ?? ""))) failures.push("METADATA_INVALID:adapterProfile");
  if (!SAFE_OPAQUE.test(String(metadata.initiatedBy ?? ""))) failures.push("METADATA_INVALID:initiatedBy");
  if (!isIsoDate(metadata.startedAt) || !isIsoDate(metadata.finishedAt)
      || Date.parse(metadata.finishedAt) < Date.parse(metadata.startedAt)) {
    failures.push("METADATA_INVALID:timeRange");
  }
}

function validateEvidence(evidenceFiles, failures) {
  const byId = new Map();
  const files = new Set();
  for (const evidence of evidenceFiles) {
    const id = String(evidence?.id ?? "");
    if (!SAFE_OPAQUE.test(id)) failures.push(`EVIDENCE_INVALID_ID:${id || "EMPTY"}`);
    if (byId.has(id)) failures.push(`EVIDENCE_DUPLICATE_ID:${id}`);
    byId.set(id, evidence);
    if (!TEST_IDS.has(evidence?.testId)) failures.push(`EVIDENCE_INVALID_TEST:${id}`);
    if (!safeRelativeEvidencePath(evidence?.file)) failures.push(`EVIDENCE_UNSAFE_PATH:${id}`);
    if (files.has(evidence?.file)) failures.push(`EVIDENCE_DUPLICATE_FILE:${id}`);
    files.add(evidence?.file);
    if (!SHA256.test(String(evidence?.sha256 ?? ""))) failures.push(`EVIDENCE_INVALID_SHA:${id}`);
    if (!Number.isSafeInteger(evidence?.sizeBytes) || evidence.sizeBytes < 2
        || evidence.sizeBytes > MAX_EVIDENCE_FILE_BYTES) failures.push(`EVIDENCE_INVALID_SIZE:${id}`);
    if (evidence?.mediaType !== "application/json") failures.push(`EVIDENCE_INVALID_MEDIA_TYPE:${id}`);
    if (!SAFE_OPAQUE.test(String(evidence?.kind ?? ""))) failures.push(`EVIDENCE_INVALID_KIND:${id}`);
  }
  return byId;
}

function validateEvidenceRefs(test, result, evidenceById, referenced, failures, requiredKinds) {
  if (!Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0) {
    failures.push(`EVIDENCE_MISSING:${test.id}`);
    return;
  }
  const uniqueRefs = new Set(result.evidenceRefs);
  if (uniqueRefs.size !== result.evidenceRefs.length) failures.push(`EVIDENCE_DUPLICATE_REF:${test.id}`);
  const foundKinds = new Set();
  for (const ref of uniqueRefs) {
    const evidence = evidenceById.get(ref);
    referenced.add(ref);
    if (!evidence) {
      failures.push(`EVIDENCE_UNKNOWN_REF:${test.id}:${ref}`);
      continue;
    }
    if (evidence.testId !== test.id) failures.push(`EVIDENCE_WRONG_TEST:${test.id}:${ref}`);
    foundKinds.add(evidence.kind);
  }
  for (const kind of requiredKinds) {
    if (!foundKinds.has(kind)) failures.push(`EVIDENCE_KIND_MISSING:${test.id}:${kind}`);
  }
}

function validateExitCriteria(exitCriteria, failures) {
  if (exitCriteria?.preflight?.result !== "PASS"
      || !SHA256.test(String(exitCriteria?.preflight?.evidenceDigest ?? ""))) {
    failures.push("EXIT_PRECHECK_NOT_PROVEN");
  }
  if (exitCriteria?.phaseZero?.result !== "PASS"
      || !SHA256.test(String(exitCriteria?.phaseZero?.evidenceDigest ?? ""))) {
    failures.push("EXIT_PHASE_ZERO_NOT_PROVEN");
  }
  if (exitCriteria?.openCriticalFindings !== 0) failures.push("EXIT_CRITICAL_FINDINGS_OPEN");
  if (exitCriteria?.openHighFindings !== 0) failures.push("EXIT_HIGH_FINDINGS_OPEN");
}

function approvalFailures(approvals, needsLegalApproval) {
  const failures = [];
  const required = needsLegalApproval
    ? [...REQUIRED_APPROVAL_ROLES, "HUKUK_KVKK"] : [...REQUIRED_APPROVAL_ROLES];
  const byRole = new Map();
  for (const approval of approvals ?? []) {
    if (byRole.has(approval?.role)) failures.push(`APPROVAL_DUPLICATE:${approval?.role ?? "UNKNOWN"}`);
    byRole.set(approval?.role, approval);
  }
  for (const role of required) {
    const approval = byRole.get(role);
    if (!approval) {
      failures.push(`APPROVAL_MISSING:${role}`);
      continue;
    }
    if (!SAFE_OPAQUE.test(String(approval.subjectId ?? ""))) failures.push(`APPROVAL_INVALID_SUBJECT:${role}`);
    if (!isIsoDate(approval.approvedAt)) failures.push(`APPROVAL_INVALID_TIME:${role}`);
    if (!SHA256.test(String(approval.evidenceDigest ?? ""))) failures.push(`APPROVAL_INVALID_EVIDENCE:${role}`);
  }
  return failures;
}

/** Teknik kapı: test kanıtları ile Faz 0/güvenlik ön koşullarını doğrular. */
export function evaluateTechnicalGate(results, options = {}) {
  const failures = [];
  const evidenceFiles = Array.isArray(options.evidenceFiles) ? options.evidenceFiles : [];
  const evidenceById = validateEvidence(evidenceFiles, failures);
  const referenced = new Set();
  validateMetadata(options.metadata, failures);
  validateExitCriteria(options.exitCriteria, failures);

  const byId = new Map(results.map((result) => [result.id, result]));
  if (results.length !== byId.size) failures.push("DUPLICATE_RESULT");
  for (const test of TEST_CATALOG) {
    const result = byId.get(test.id);
    if (!result) {
      failures.push(`MISSING:${test.id}`);
      continue;
    }
    if (!RESULTS.includes(result.result)) {
      failures.push(`INVALID_RESULT:${test.id}`);
      continue;
    }
    if (result.result === "PASS") {
      if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 0) failures.push(`INVALID_DURATION:${test.id}`);
      if (!SAFE_CORRELATION.test(String(result.correlationId ?? ""))) failures.push(`INVALID_CORRELATION:${test.id}`);
      validateEvidenceRefs(test, result, evidenceById, referenced, failures, test.evidenceKinds);
      continue;
    }
    if (result.result === "NOT_APPLICABLE") {
      const compensation = result.compensatingControl;
      if (test.id !== "T-07" || result.adrReference !== "ADR-016") {
        failures.push(`NOT_APPLICABLE_UNAUTHORIZED:${test.id}`);
      }
      if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 0) failures.push(`INVALID_DURATION:${test.id}`);
      if (!SAFE_CORRELATION.test(String(result.correlationId ?? ""))) failures.push(`INVALID_CORRELATION:${test.id}`);
      if (compensation?.result !== "PASS") failures.push("T-07_COMPENSATING_CONTROL_NOT_PASS");
      validateEvidenceRefs(test, result, evidenceById, referenced, failures,
        ["decision", "compensating-control", "integrity"]);
      continue;
    }
    if (Array.isArray(result.evidenceRefs) && result.evidenceRefs.length > 0) {
      validateEvidenceRefs(test, result, evidenceById, referenced, failures, []);
    }
    if (result.errorCode !== undefined && result.errorCode !== null
        && !SAFE_ERROR_CODE.test(String(result.errorCode))) failures.push(`INVALID_ERROR_CODE:${test.id}`);
    failures.push(`${result.result}:${test.id}`);
  }
  for (const result of results) {
    if (!TEST_IDS.has(result.id)) failures.push(`UNKNOWN_TEST:${result.id}`);
  }
  for (const evidence of evidenceFiles) {
    if (!referenced.has(evidence.id)) failures.push(`EVIDENCE_UNREFERENCED:${evidence.id}`);
  }
  return { passed: failures.length === 0, failures: [...new Set(failures)].sort() };
}

/** Tam çıkış kapısı: teknik kapıya değişmez kurumsal onay kanıtlarını ekler. */
export function evaluateGate(results, options = {}) {
  const technical = evaluateTechnicalGate(results, options);
  const t07 = results.find((result) => result.id === "T-07");
  const failures = [...technical.failures, ...approvalFailures(options.approvals, t07?.result === "NOT_APPLICABLE")];
  return { passed: failures.length === 0, failures: [...new Set(failures)].sort() };
}

const SECRET_ENV_PATTERN = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;

export function maskContext(context) {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => {
    if (typeof value === "boolean") return [key, value];
    if (value === null || value === undefined || value === "") return [key, false];
    if (SECRET_ENV_PATTERN.test(key)) return [key, true];
    if (key === "baseUrl") return [key, maskUrl(String(value))];
    return [key, true];
  }));
}

function maskUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return true;
  }
}

function safeOpaqueOrNull(value) {
  return SAFE_OPAQUE.test(String(value ?? "")) ? String(value) : null;
}

function cleanResult(result) {
  return {
    id: safeOpaqueOrNull(result.id),
    title: TEST_CATALOG.find((test) => test.id === result.id)?.title ?? null,
    result: RESULTS.includes(result.result) ? result.result : null,
    durationMs: Number.isSafeInteger(result.durationMs) && result.durationMs >= 0 ? result.durationMs : null,
    correlationId: SAFE_CORRELATION.test(String(result.correlationId ?? "")) ? result.correlationId : null,
    errorCode: SAFE_ERROR_CODE.test(String(result.errorCode ?? "")) ? result.errorCode : null,
    adrReference: result.adrReference === "ADR-016" ? result.adrReference : null,
    evidenceRefs: Array.isArray(result.evidenceRefs)
      ? result.evidenceRefs.map(safeOpaqueOrNull).filter(Boolean).sort() : [],
    compensatingControl: result.compensatingControl?.result === "PASS" ? { result: "PASS" } : null,
    blockedOn: Array.isArray(result.blockedOn)
      ? result.blockedOn.map(safeOpaqueOrNull).filter(Boolean).sort() : null,
    executor: TEST_CATALOG.find((test) => test.id === result.id)?.executor ?? null,
    approver: TEST_CATALOG.find((test) => test.id === result.id)?.approver ?? null,
  };
}

function cleanEvidence(evidence) {
  return {
    id: safeOpaqueOrNull(evidence?.id),
    testId: TEST_IDS.has(evidence?.testId) ? evidence.testId : null,
    kind: safeOpaqueOrNull(evidence?.kind),
    file: safeRelativeEvidencePath(evidence?.file) ? evidence.file : null,
    sha256: SHA256.test(String(evidence?.sha256 ?? "")) ? evidence.sha256 : null,
    sizeBytes: Number.isSafeInteger(evidence?.sizeBytes) ? evidence.sizeBytes : null,
    mediaType: evidence?.mediaType === "application/json" ? "application/json" : null,
  };
}

function cleanApproval(approval) {
  return {
    role: safeOpaqueOrNull(approval?.role),
    subjectId: safeOpaqueOrNull(approval?.subjectId),
    approvedAt: isIsoDate(approval?.approvedAt) ? approval.approvedAt : null,
    evidenceDigest: SHA256.test(String(approval?.evidenceDigest ?? "")) ? approval.evidenceDigest : null,
  };
}

function cleanMetadata(input) {
  return {
    runId: safeOpaqueOrNull(input.runId),
    gitCommit: GIT_SHA.test(String(input.gitCommit ?? "")) ? input.gitCommit : null,
    appVersion: safeOpaqueOrNull(input.appVersion),
    schemaVersion: Number.isSafeInteger(input.schemaVersion) ? input.schemaVersion : null,
    environment: input.environment === "staging" ? "staging" : null,
    adapterProfile: safeOpaqueOrNull(input.adapterProfile),
    initiatedBy: safeOpaqueOrNull(input.initiatedBy),
    startedAt: isIsoDate(input.startedAt) ? input.startedAt : null,
    finishedAt: isIsoDate(input.finishedAt) ? input.finishedAt : null,
  };
}

function cleanExitCriteria(criteria) {
  const cleanProof = (proof) => ({
    result: proof?.result === "PASS" ? "PASS" : "BLOCKED",
    evidenceDigest: SHA256.test(String(proof?.evidenceDigest ?? "")) ? proof.evidenceDigest : null,
  });
  return {
    preflight: cleanProof(criteria?.preflight),
    phaseZero: cleanProof(criteria?.phaseZero),
    openCriticalFindings: Number.isSafeInteger(criteria?.openCriticalFindings)
      ? criteria.openCriticalFindings : null,
    openHighFindings: Number.isSafeInteger(criteria?.openHighFindings)
      ? criteria.openHighFindings : null,
  };
}

export function buildEvidenceManifest(input) {
  const metadata = cleanMetadata(input);
  const results = (input.results ?? []).map(cleanResult);
  const evidenceFiles = (input.evidenceFiles ?? []).map(cleanEvidence);
  const exitCriteria = cleanExitCriteria(input.exitCriteria);
  const approvals = (input.approvals ?? []).map(cleanApproval);
  const technicalGate = evaluateTechnicalGate(results, { metadata, evidenceFiles, exitCriteria });
  const releaseGate = evaluateGate(results, { metadata, evidenceFiles, exitCriteria, approvals });
  const manifest = {
    contractVersion: ACCEPTANCE_CONTRACT_VERSION,
    catalogDigest: TEST_CATALOG_DIGEST,
    ...metadata,
    source: {
      repository: safeOpaqueOrNull(input.source?.repository),
      workflow: safeOpaqueOrNull(input.source?.workflow),
      runAttempt: Number.isSafeInteger(input.source?.runAttempt) ? input.source.runAttempt : null,
    },
    context: maskContext(input.context ?? {}),
    exitCriteria,
    approvals: approvals.sort((left, right) => String(left.role).localeCompare(String(right.role))),
    results: results.sort((left, right) => String(left.id).localeCompare(String(right.id))),
    evidenceFiles: evidenceFiles.sort((left, right) => String(left.file).localeCompare(String(right.file))),
    technicalGate,
    releaseGate,
  };
  return { manifest, digest: sha256Hex(canonicalJson(manifest)) };
}
