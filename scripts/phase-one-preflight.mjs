import { TEST_CATALOG } from "./phase-one-acceptance-core.mjs";

const REQUIRED_CAPABILITIES = Object.freeze([
  "staging", "s3", "iamIdentities", "providerLockProfile", "restoreDrill",
  "secondProvider", "logAccess", "faultInjection", "largeFixtures",
]);

function text(env, name) {
  return typeof env[name] === "string" && env[name].trim().length > 0;
}

function secret(env, name) {
  return typeof env[name] === "string" && env[name].length >= 32;
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** Canlı işlem yapmaz ve değer döndürmez; yalnız güvenli hata kodları üretir. */
export function validatePhaseOnePreflight(env, capabilities, executorIds) {
  const failures = [];
  for (const capability of REQUIRED_CAPABILITIES) {
    if (capabilities[capability] !== true) failures.push(`CAPABILITY_MISSING:${capability}`);
  }

  const configuredExecutors = new Set(executorIds);
  for (const test of TEST_CATALOG) {
    if (!configuredExecutors.has(test.id)) failures.push(`EXECUTOR_MISSING:${test.id}`);
  }
  for (const id of configuredExecutors) {
    if (!TEST_CATALOG.some((test) => test.id === id)) failures.push(`EXECUTOR_UNKNOWN:${id}`);
  }

  if (env.ACCEPTANCE_OPEN_CRITICAL_FINDINGS !== "0") failures.push("CRITICAL_FINDINGS_NOT_ZERO");
  if (env.ACCEPTANCE_OPEN_HIGH_FINDINGS !== "0") failures.push("HIGH_FINDINGS_NOT_ZERO");
  if (!text(env, "ACCEPTANCE_ADAPTER_PROFILE")) failures.push("ADAPTER_PROFILE_MISSING");
  if (!text(env, "ACCEPTANCE_UPLOADER_UNIT")) failures.push("UPLOADER_UNIT_MISSING");
  if (env.ACCEPTANCE_PRODUCTION_GUARD !== "confirmed-non-production") failures.push("PRODUCTION_GUARD_INVALID");

  const stagingUrl = normalizedUrl(env.ACCEPTANCE_BASE_URL);
  const productionUrl = normalizedUrl(env.ACCEPTANCE_PRODUCTION_BASE_URL);
  if (!productionUrl?.startsWith("https://")) failures.push("PRODUCTION_URL_INVALID");
  if (stagingUrl && productionUrl && stagingUrl === productionUrl) failures.push("STAGING_EQUALS_PRODUCTION");

  for (const name of [
    "ARCHIVE_ACCEPTANCE_TOKEN", "ACCEPTANCE_PROXY_TOKEN", "ACCEPTANCE_LOG_TOKEN",
    "ACCEPTANCE_RESOURCE_METRICS_TOKEN",
  ]) {
    if (!secret(env, name)) failures.push(`SECRET_INVALID:${name}`);
  }

  const rolePrefixes = ["VIEWER", "APPLICATION", "SCANNER", "OCR"];
  for (const suffix of ["ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]) {
    const values = rolePrefixes.map((role) => env[`ACCEPTANCE_${role}_S3_${suffix}`]?.trim());
    if (values.some((value) => !value) || new Set(values).size !== values.length) {
      failures.push(`IAM_ROLES_NOT_DISTINCT:${suffix}`);
    }
  }
  for (const role of rolePrefixes) {
    if (!secret(env, `ACCEPTANCE_${role}_S3_SECRET_ACCESS_KEY`)) {
      failures.push(`IAM_ROLE_SECRET_INVALID:${role}`);
    }
  }
  const identities = [
    env.ACCEPTANCE_VIEWER_IDENTITY?.trim(),
    env.ACCEPTANCE_UPLOADER_IDENTITY?.trim(),
    env.ACCEPTANCE_UNAUTHORIZED_IDENTITY?.trim(),
  ];
  if (identities.some((value) => !value) || new Set(identities).size !== identities.length) {
    failures.push("APPLICATION_IDENTITIES_NOT_DISTINCT");
  }

  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}
