#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
  if (!match) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return [match[1], value];
}

export function parseOnpremEnv(text) {
  const values = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) values[parsed[0]] = parsed[1];
  }
  return values;
}

function validHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return value;
  }
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function memoryLimitBytes(value) {
  const match = /^(\d+(?:\.\d+)?)([kmgt])$/i.exec(value ?? "");
  if (!match) return null;
  const exponent = { k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()];
  const bytes = Number(match[1]) * (1024 ** exponent);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function secret(value) {
  return typeof value === "string" && value.length >= 32;
}

function immutableImage(value) {
  return typeof value === "string"
    && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(value);
}

function wormDuration(value) {
  const match = /^(\d+)([dmy])$/.exec(value ?? "");
  return Boolean(match && Number(match[1]) > 0);
}

function decisionReference(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{5,127}$/.test(value);
}

/** Değerleri asla döndürmez; yalnız kararlı hata kodları üretir. */
export function validateOnpremRuntimeEnv(values, deployEnvironment, options = {}) {
  const failures = [];
  const production = deployEnvironment === "production";
  const requireEdge = production || options.requireEdge === true;
  const add = (condition, code) => { if (!condition) failures.push(code); };

  add(values.APP_ENV === deployEnvironment, "APP_ENV_MISMATCH");

  const backupConfigured = present(values.ARCHIVE_S3_BUCKET_BACKUP)
    || present(values.ARCHIVE_BACKUP_S3_ENDPOINT);
  if (production || backupConfigured) {
    add(present(values.ARCHIVE_S3_BUCKET_BACKUP), "BACKUP_BUCKET_MISSING");
    add(validHttps(values.ARCHIVE_BACKUP_S3_ENDPOINT), "BACKUP_ENDPOINT_INVALID");
    add(present(values.ARCHIVE_BACKUP_S3_ACCESS_KEY_ID), "BACKUP_ACCESS_KEY_MISSING");
    add(secret(values.ARCHIVE_BACKUP_S3_SECRET_ACCESS_KEY), "BACKUP_SECRET_INVALID");
    add(values.ARCHIVE_BACKUP_S3_ACCESS_KEY_ID !== values.ARCHIVE_S3_ACCESS_KEY_ID,
      "BACKUP_ACCESS_KEY_NOT_DISTINCT");
    add(values.ARCHIVE_BACKUP_S3_SECRET_ACCESS_KEY !== values.ARCHIVE_S3_SECRET_ACCESS_KEY,
      "BACKUP_SECRET_NOT_DISTINCT");
    if (present(values.ARCHIVE_S3_ENDPOINT)) {
      add(normalizedUrl(values.ARCHIVE_BACKUP_S3_ENDPOINT) !== normalizedUrl(values.ARCHIVE_S3_ENDPOINT),
        "BACKUP_ENDPOINT_NOT_DISTINCT");
    }
  }

  const alarmConfigured = present(values.ALARM_WEBHOOK_URL) || present(values.ALARM_WEBHOOK_TOKEN);
  if (production || alarmConfigured) {
    add(validHttps(values.ALARM_WEBHOOK_URL), "ALARM_WEBHOOK_INVALID");
    add(secret(values.ALARM_WEBHOOK_TOKEN), "ALARM_TOKEN_INVALID");
  }
  if (production || present(values.ARCHIVE_STORAGE_QUOTA_GB)) {
    add(positiveNumber(values.ARCHIVE_STORAGE_QUOTA_GB), "STORAGE_QUOTA_INVALID");
  }

  const profiles = new Set((values.COMPOSE_PROFILES ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const pitrConfigured = profiles.has("pitr") || present(values.SQLITE_PITR_S3_ENDPOINT);
  if (production || pitrConfigured) {
    add(profiles.has("pitr"), "PITR_PROFILE_DISABLED");
    add(validHttps(values.SQLITE_PITR_S3_ENDPOINT), "PITR_ENDPOINT_INVALID");
    add(present(values.SQLITE_PITR_S3_BUCKET), "PITR_BUCKET_MISSING");
    add(present(values.SQLITE_PITR_S3_PREFIX), "PITR_PREFIX_MISSING");
    add(present(values.SQLITE_PITR_S3_ACCESS_KEY_ID), "PITR_ACCESS_KEY_MISSING");
    add(secret(values.SQLITE_PITR_S3_SECRET_ACCESS_KEY), "PITR_SECRET_INVALID");
    add(validHttps(values.SQLITE_PITR_HEARTBEAT_URL), "PITR_HEARTBEAT_INVALID");
    add(normalizedUrl(values.SQLITE_PITR_S3_ENDPOINT) !== normalizedUrl(values.ARCHIVE_BACKUP_S3_ENDPOINT),
      "PITR_ENDPOINT_NOT_DISTINCT");
    add(values.SQLITE_PITR_S3_ACCESS_KEY_ID !== values.ARCHIVE_BACKUP_S3_ACCESS_KEY_ID,
      "PITR_ACCESS_KEY_NOT_DISTINCT");
    add(values.SQLITE_PITR_S3_SECRET_ACCESS_KEY !== values.ARCHIVE_BACKUP_S3_SECRET_ACCESS_KEY,
      "PITR_SECRET_NOT_DISTINCT");
    add(values.SQLITE_PITR_S3_ACCESS_KEY_ID !== values.ARCHIVE_S3_ACCESS_KEY_ID,
      "PITR_ACCESS_KEY_EQUALS_PRIMARY");
    add(values.SQLITE_PITR_S3_SECRET_ACCESS_KEY !== values.ARCHIVE_S3_SECRET_ACCESS_KEY,
      "PITR_SECRET_EQUALS_PRIMARY");
  }

  if (production) {
    add(values.ARCHIVE_WORM_POLICY_APPROVED === "approved-production-policy",
      "WORM_POLICY_NOT_APPROVED");
    add(wormDuration(values.ARCHIVE_WORM_RETENTION_DURATION), "WORM_DURATION_INVALID");
    add(values.ARCHIVE_WORM_RETENTION_DURATION !== "1d", "WORM_STAGING_DURATION_IN_PRODUCTION");
    add(decisionReference(values.ARCHIVE_WORM_POLICY_REFERENCE), "WORM_POLICY_REFERENCE_INVALID");
    add(values.SQLITE_PITR_RESTORE_DRILL_APPROVED === "approved-representative-restore",
      "PITR_RESTORE_DRILL_NOT_APPROVED");
  }

  if (requireEdge) {
    const configuredMemoryBytes = Number(values.API_MEMORY_LIMIT_BYTES);
    add(memoryLimitBytes(values.API_MEMORY_LIMIT) !== null, "API_MEMORY_LIMIT_INVALID");
    add(Number.isSafeInteger(configuredMemoryBytes) && configuredMemoryBytes > 0,
      "API_MEMORY_LIMIT_BYTES_INVALID");
    if (memoryLimitBytes(values.API_MEMORY_LIMIT) !== null
        && Number.isSafeInteger(configuredMemoryBytes)) {
      add(memoryLimitBytes(values.API_MEMORY_LIMIT) === configuredMemoryBytes,
        "API_MEMORY_LIMIT_MISMATCH");
    }
    add(present(values.ARCHIVE_CANONICAL_HOST), "CANONICAL_HOST_MISSING");
    add(values.ARCHIVE_EXTERNAL_SCHEME === "https", "EXTERNAL_SCHEME_INVALID");
    add(validHttps(values.SSO_ISSUER_URL), "SSO_ISSUER_INVALID");
    add(validHttps(values.SSO_REDIRECT_URL), "SSO_REDIRECT_INVALID");
    if (validHttps(values.SSO_REDIRECT_URL) && present(values.ARCHIVE_CANONICAL_HOST)) {
      const redirect = new URL(values.SSO_REDIRECT_URL);
      add(redirect.hostname === values.ARCHIVE_CANONICAL_HOST
        && redirect.pathname === "/oauth2/callback", "SSO_REDIRECT_MISMATCH");
    }
    add(present(values.SSO_CLIENT_ID), "SSO_CLIENT_ID_MISSING");
    add((values.SSO_CLIENT_SECRET?.length ?? 0) >= 16, "SSO_CLIENT_SECRET_INVALID");
    add(secret(values.SSO_COOKIE_SECRET), "SSO_COOKIE_SECRET_INVALID");
    add(values.SSO_COOKIE_SECURE === "true", "SSO_COOKIE_NOT_SECURE");
    add(present(values.SSO_EMAIL_DOMAINS) && values.SSO_EMAIL_DOMAINS !== "*",
      "SSO_EMAIL_DOMAIN_INVALID");
    add(present(values.SSO_ALLOWED_REDIRECT_DOMAINS)
      && !values.SSO_ALLOWED_REDIRECT_DOMAINS.includes("*"), "SSO_REDIRECT_DOMAIN_INVALID");
    if (production) {
      add(values.ARCHIVE_ACCEPTANCE_BYPASS_ENABLED === "disabled",
        "PRODUCTION_ACCEPTANCE_BYPASS_ENABLED");
      add(!present(values.ACCEPTANCE_PROXY_TOKEN), "PRODUCTION_ACCEPTANCE_TOKEN_PRESENT");
    } else {
      add(values.ARCHIVE_ACCEPTANCE_BYPASS_ENABLED === "enabled",
        "STAGING_ACCEPTANCE_BYPASS_DISABLED");
      add(secret(values.ACCEPTANCE_PROXY_TOKEN), "ACCEPTANCE_PROXY_TOKEN_INVALID");
    }
    add(isAbsolute(values.ARCHIVE_TLS_CERT_FILE ?? ""), "TLS_CERT_PATH_INVALID");
    add(isAbsolute(values.ARCHIVE_TLS_KEY_FILE ?? ""), "TLS_KEY_PATH_INVALID");

    for (const name of [
      "MINIO_SERVER_IMAGE",
      "MINIO_CLIENT_IMAGE",
      "NGINX_IMAGE",
      "OAUTH2_PROXY_IMAGE",
    ]) add(immutableImage(values[name]), `EXTERNAL_IMAGE_NOT_IMMUTABLE:${name}`);
  }

  if ((production || pitrConfigured) && !immutableImage(values.LITESTREAM_IMAGE)) {
    failures.push("EXTERNAL_IMAGE_NOT_IMMUTABLE:LITESTREAM_IMAGE");
  }
  if (profiles.has("kimlik-yerel") && !immutableImage(values.KEYCLOAK_IMAGE)) {
    failures.push("EXTERNAL_IMAGE_NOT_IMMUTABLE:KEYCLOAK_IMAGE");
  }

  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

function run() {
  const file = process.env.ONPREM_ENV_FILE?.trim();
  const deployEnvironment = process.env.DEPLOY_ENV?.trim();
  let result;
  try {
    if (!file) throw new Error("ONPREM_ENV_FILE_MISSING");
    if (deployEnvironment !== "staging" && deployEnvironment !== "production") {
      throw new Error("DEPLOY_ENV_INVALID");
    }
    const values = parseOnpremEnv(readFileSync(file, "utf8"));
    const requireEdge = process.env.ONPREM_REQUIRE_EDGE === "enabled";
    result = validateOnpremRuntimeEnv(values, deployEnvironment, { requireEdge });
    if (result.ok && (deployEnvironment === "production" || requireEdge)) {
      const fileFailures = [];
      for (const [name, code] of [
        ["ARCHIVE_TLS_CERT_FILE", "TLS_CERT_FILE_INVALID"],
        ["ARCHIVE_TLS_KEY_FILE", "TLS_KEY_FILE_INVALID"],
      ]) {
        const path = values[name];
        if (!path || !existsSync(path) || !statSync(path).isFile()) fileFailures.push(code);
      }
      const key = values.ARCHIVE_TLS_KEY_FILE;
      if (key && existsSync(key) && (statSync(key).mode & 0o007) !== 0) {
        fileFailures.push("TLS_KEY_WORLD_ACCESSIBLE");
      }
      if (fileFailures.length > 0) result = { ok: false, failures: fileFailures };
    }
  } catch (error) {
    result = { ok: false, failures: [error instanceof Error ? error.message : "RUNTIME_ENV_UNREADABLE"] };
  }
  const event = result.ok ? "onprem.runtime-env.ready" : "onprem.runtime-env.invalid";
  (result.ok ? console.log : console.error)(JSON.stringify({ event, failures: result.failures }));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
