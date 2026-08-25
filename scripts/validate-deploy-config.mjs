#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const ALLOWED_ENVIRONMENTS = new Set(["staging", "production"]);

function validBaseUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && (parsed.pathname === "/" || parsed.pathname === "");
  } catch {
    return false;
  }
}

/** Dağıtımdan önce yalnız biçim ve varlık denetimi yapar; sır değerlerini döndürmez. */
export function validateDeployConfig(env) {
  const failures = [];
  const environment = env.DEPLOY_ENV?.trim();
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const baseUrl = env.DEPLOY_BASE_URL?.trim();
  const migrationToken = env.ARCHIVE_MIGRATION_TOKEN?.trim();

  if (!ALLOWED_ENVIRONMENTS.has(environment)) failures.push("DEPLOY_ENV_INVALID");
  if (!apiToken) failures.push("CLOUDFLARE_API_TOKEN_MISSING");
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "")) failures.push("CLOUDFLARE_ACCOUNT_ID_INVALID");
  if (!validBaseUrl(baseUrl)) failures.push("DEPLOY_BASE_URL_INVALID");
  if (!migrationToken || migrationToken.length < 16) failures.push("ARCHIVE_MIGRATION_TOKEN_INVALID");

  return Object.freeze({
    ok: failures.length === 0,
    environment: ALLOWED_ENVIRONMENTS.has(environment) ? environment : null,
    failures: Object.freeze(failures),
  });
}

function run() {
  const result = validateDeployConfig(process.env);
  if (!result.ok) {
    console.error(JSON.stringify({
      event: "deployment.config-invalid",
      environment: result.environment,
      failures: result.failures,
    }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    event: "deployment.config-ready",
    environment: result.environment,
    checked: [
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "DEPLOY_BASE_URL",
      "ARCHIVE_MIGRATION_TOKEN",
    ],
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
