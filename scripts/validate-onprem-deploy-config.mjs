#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const ENVIRONMENTS = new Set(["staging", "production"]);

function httpsRoot(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && !url.search && !url.hash && (url.pathname === "" || url.pathname === "/");
  } catch {
    return false;
  }
}

export function validateOnpremDeployConfig(env, { checkFiles = false } = {}) {
  const failures = [];
  const environment = env.DEPLOY_ENV?.trim();
  const prefix = env.ONPREM_IMAGE_PREFIX?.trim();
  const tag = env.ONPREM_IMAGE_TAG?.trim();
  const envFile = env.ONPREM_ENV_FILE?.trim();
  const stateFile = env.ONPREM_RELEASE_STATE_FILE?.trim();

  if (!ENVIRONMENTS.has(environment)) failures.push("DEPLOY_ENV_INVALID");
  if (!/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+$/.test(prefix ?? "")) failures.push("IMAGE_PREFIX_INVALID");
  if (!/^[a-f0-9]{40}$/.test(tag ?? "")) failures.push("IMAGE_TAG_INVALID");
  if (!httpsRoot(env.DEPLOY_BASE_URL?.trim())) failures.push("DEPLOY_BASE_URL_INVALID");
  if ((env.ARCHIVE_MIGRATION_TOKEN?.trim().length ?? 0) < 16) failures.push("ARCHIVE_MIGRATION_TOKEN_INVALID");
  if (!envFile || !isAbsolute(envFile)) failures.push("ONPREM_ENV_FILE_INVALID");
  if (!stateFile || !isAbsolute(stateFile)) failures.push("ONPREM_RELEASE_STATE_FILE_INVALID");

  if (checkFiles && envFile && isAbsolute(envFile)) {
    if (!existsSync(envFile) || !statSync(envFile).isFile()) {
      failures.push("ONPREM_ENV_FILE_MISSING");
    } else if ((statSync(envFile).mode & 0o007) !== 0) {
      failures.push("ONPREM_ENV_FILE_WORLD_ACCESSIBLE");
    }
  }

  return Object.freeze({
    ok: failures.length === 0,
    environment: ENVIRONMENTS.has(environment) ? environment : null,
    failures: Object.freeze(failures),
  });
}

function run() {
  const result = validateOnpremDeployConfig(process.env, { checkFiles: true });
  const event = result.ok ? "onprem.deployment.config-ready" : "onprem.deployment.config-invalid";
  const output = { event, environment: result.environment, failures: result.failures };
  (result.ok ? console.log : console.error)(JSON.stringify(output));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
