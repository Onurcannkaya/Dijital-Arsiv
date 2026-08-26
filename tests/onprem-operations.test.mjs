import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { validateNodeProductionStorage } from "../lib/node-runtime.ts";
import {
  parseOnpremEnv,
  validateOnpremRuntimeEnv,
} from "../scripts/validate-onprem-runtime-env.mjs";
import { verifySqliteRestore } from "../scripts/verify-sqlite-restore.mjs";

const compose = readFileSync(new URL("../deploy/kurum-ici/docker-compose.yml", import.meta.url), "utf8");
const litestream = readFileSync(new URL("../deploy/kurum-ici/litestream/litestream.yml", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/deploy-onprem.yml", import.meta.url), "utf8");

function productionEnv(overrides = {}) {
  return {
    APP_ENV: "production",
    ARCHIVE_S3_ENDPOINT: "http://minio:9000",
    ARCHIVE_S3_ACCESS_KEY_ID: "archive-api",
    ARCHIVE_S3_SECRET_ACCESS_KEY: "a".repeat(32),
    ARCHIVE_S3_BUCKET_BACKUP: "archive-backup",
    ARCHIVE_BACKUP_S3_ENDPOINT: "https://backup.example.test",
    ARCHIVE_BACKUP_S3_ACCESS_KEY_ID: "backup-writer",
    ARCHIVE_BACKUP_S3_SECRET_ACCESS_KEY: "b".repeat(32),
    ARCHIVE_STORAGE_QUOTA_GB: "1000",
    ALARM_WEBHOOK_URL: "https://alarm.example.test/archive",
    ALARM_WEBHOOK_TOKEN: "c".repeat(32),
    COMPOSE_PROFILES: "pitr",
    SQLITE_PITR_S3_ENDPOINT: "https://pitr.example.test",
    SQLITE_PITR_S3_BUCKET: "sqlite-pitr",
    SQLITE_PITR_S3_PREFIX: "archive",
    SQLITE_PITR_S3_ACCESS_KEY_ID: "pitr-writer",
    SQLITE_PITR_S3_SECRET_ACCESS_KEY: "d".repeat(32),
    SQLITE_PITR_HEARTBEAT_URL: "https://alarm.example.test/pitr",
    ARCHIVE_WORM_POLICY_APPROVED: "approved-production-policy",
    ARCHIVE_WORM_RETENTION_DURATION: "10y",
    ARCHIVE_WORM_POLICY_REFERENCE: "KARAR-2026-001",
    SQLITE_PITR_RESTORE_DRILL_APPROVED: "approved-representative-restore",
    ARCHIVE_CANONICAL_HOST: "archive.example.test",
    ARCHIVE_EXTERNAL_SCHEME: "https",
    SSO_ISSUER_URL: "https://identity.example.test/realms/archive",
    SSO_REDIRECT_URL: "https://archive.example.test/oauth2/callback",
    SSO_CLIENT_ID: "archive-client",
    SSO_CLIENT_SECRET: "e".repeat(32),
    SSO_COOKIE_SECRET: "f".repeat(32),
    SSO_COOKIE_SECURE: "true",
    SSO_EMAIL_DOMAINS: "example.test",
    SSO_ALLOWED_REDIRECT_DOMAINS: ".example.test",
    ARCHIVE_ACCEPTANCE_BYPASS_ENABLED: "disabled",
    ACCEPTANCE_PROXY_TOKEN: "",
    API_MEMORY_LIMIT: "2g",
    API_MEMORY_LIMIT_BYTES: "2147483648",
    ARCHIVE_TLS_CERT_FILE: "/etc/archive-tls/fullchain.pem",
    ARCHIVE_TLS_KEY_FILE: "/etc/archive-tls/privkey.pem",
    MINIO_SERVER_IMAGE: `minio/minio@sha256:${"1".repeat(64)}`,
    MINIO_CLIENT_IMAGE: `minio/mc@sha256:${"2".repeat(64)}`,
    NGINX_IMAGE: `nginx@sha256:${"3".repeat(64)}`,
    OAUTH2_PROXY_IMAGE: `quay.io/oauth2-proxy/oauth2-proxy@sha256:${"4".repeat(64)}`,
    LITESTREAM_IMAGE: `litestream/litestream@sha256:${"5".repeat(64)}`,
    ...overrides,
  };
}

test("PITR sidecar varsayılan yığını değiştirmeden ayrı profile ve yerel SQLite birimine bağlanır", () => {
  assert.match(compose, /litestream\/litestream:0\.5\.16-scratch/);
  assert.match(compose, /profiles: \[pitr\]/);
  assert.match(compose, /- api-veri:\/veri/);
  assert.match(compose, /SQLITE_PITR_HEARTBEAT_URL/);
  assert.match(litestream, /retention:\s+enabled: false/);
  assert.match(litestream, /verify-compaction: true/);
  assert.match(litestream, /sync-interval: 10s/);
});

test("API nesne yedeği, alarm ve kota yapılandırmasını alır", () => {
  for (const name of [
    "ARCHIVE_S3_BUCKET_BACKUP",
    "ARCHIVE_BACKUP_S3_ENDPOINT",
    "ARCHIVE_BACKUP_S3_ACCESS_KEY_ID",
    "ARCHIVE_BACKUP_S3_SECRET_ACCESS_KEY",
    "ARCHIVE_STORAGE_QUOTA_GB",
    "ALARM_WEBHOOK_URL",
    "ALARM_WEBHOOK_TOKEN",
  ]) assert.match(compose, new RegExp(`${name}:`));
  assert.match(workflow, /validate-onprem-runtime-env\.mjs/);
});

test("env ayrıştırıcısı yorumları ve tırnakları sırları dışarı vermeden işler", () => {
  assert.deepEqual(parseOnpremEnv("# x\nAPP_ENV=staging\nTOKEN='abc # def'\nA=x # comment\n"), {
    APP_ENV: "staging",
    TOKEN: "abc # def",
    A: "x",
  });
});

test("üretim çalışma ortamı ikinci hata alanı ve geri yükleme kanıtı olmadan kapanır", () => {
  assert.deepEqual(validateOnpremRuntimeEnv(productionEnv(), "production"), { ok: true, failures: [] });
  const unsafe = validateOnpremRuntimeEnv(productionEnv({
    ARCHIVE_BACKUP_S3_ENDPOINT: "http://minio:9000",
    SQLITE_PITR_S3_ACCESS_KEY_ID: "backup-writer",
    SQLITE_PITR_RESTORE_DRILL_APPROVED: "",
    ARCHIVE_WORM_RETENTION_DURATION: "1d",
    ARCHIVE_WORM_POLICY_REFERENCE: "",
  }), "production");
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.failures.includes("BACKUP_ENDPOINT_INVALID"));
  assert.ok(unsafe.failures.includes("PITR_ACCESS_KEY_NOT_DISTINCT"));
  assert.ok(unsafe.failures.includes("PITR_RESTORE_DRILL_NOT_APPROVED"));
  assert.ok(unsafe.failures.includes("WORM_STAGING_DURATION_IN_PRODUCTION"));
  assert.ok(unsafe.failures.includes("WORM_POLICY_REFERENCE_INVALID"));
});

test("staging mevcut yalın kurulumda PITR/yedek zorunlu olmadan çalışır", () => {
  assert.deepEqual(validateOnpremRuntimeEnv({ APP_ENV: "staging" }, "staging"), {
    ok: true,
    failures: [],
  });
});

test("TLS/SSO edge açıkken güvenli çerez, sabit şema ve kanonik dönüş zorunludur", () => {
  const safe = {
    ...productionEnv(),
    APP_ENV: "staging",
    ARCHIVE_ACCEPTANCE_BYPASS_ENABLED: "enabled",
    ACCEPTANCE_PROXY_TOKEN: "g".repeat(32),
  };
  assert.equal(validateOnpremRuntimeEnv(safe, "staging", { requireEdge: true }).ok, true);
  const unsafe = validateOnpremRuntimeEnv({
    ...safe,
    ARCHIVE_EXTERNAL_SCHEME: "http",
    SSO_COOKIE_SECURE: "false",
    SSO_REDIRECT_URL: "https://evil.example.test/oauth2/callback",
  }, "staging", { requireEdge: true });
  assert.ok(unsafe.failures.includes("EXTERNAL_SCHEME_INVALID"));
  assert.ok(unsafe.failures.includes("SSO_COOKIE_NOT_SECURE"));
  assert.ok(unsafe.failures.includes("SSO_REDIRECT_MISMATCH"));
});

test("kaynak kanıtı için API bellek tavanı Compose sınırıyla birebir eşleşir", () => {
  const unsafe = validateOnpremRuntimeEnv(productionEnv({
    API_MEMORY_LIMIT: "3g",
    API_MEMORY_LIMIT_BYTES: "2147483648",
  }), "production");
  assert.ok(unsafe.failures.includes("API_MEMORY_LIMIT_MISMATCH"));
});

test("production SSO kabul bypass'ını ve kabul jetonunu tamamen reddeder", () => {
  const unsafe = validateOnpremRuntimeEnv(productionEnv({
    ARCHIVE_ACCEPTANCE_BYPASS_ENABLED: "enabled",
    ACCEPTANCE_PROXY_TOKEN: "g".repeat(32),
  }), "production");
  assert.ok(unsafe.failures.includes("PRODUCTION_ACCEPTANCE_BYPASS_ENABLED"));
  assert.ok(unsafe.failures.includes("PRODUCTION_ACCEPTANCE_TOKEN_PRESENT"));
});

test("korumalı dağıtım dış servis imajlarında hareketli etiketi reddeder", () => {
  const unsafe = validateOnpremRuntimeEnv({
    ...productionEnv(),
    APP_ENV: "staging",
    MINIO_SERVER_IMAGE: "minio/minio:latest",
  }, "staging", { requireEdge: true });
  assert.ok(unsafe.failures.includes("EXTERNAL_IMAGE_NOT_IMMUTABLE:MINIO_SERVER_IMAGE"));
});

test("Node üretim önyüklemesi aynı uç veya kimliğe düşen yedeği reddeder", () => {
  assert.doesNotThrow(() => validateNodeProductionStorage(productionEnv()));
  assert.throws(() => validateNodeProductionStorage(productionEnv({
    ARCHIVE_BACKUP_S3_ENDPOINT: "http://minio:9000",
  })), /TLS/);
  assert.throws(() => validateNodeProductionStorage(productionEnv({
    ARCHIVE_BACKUP_S3_ACCESS_KEY_ID: "archive-api",
  })), /ayrı erişim kimliği/);
  assert.throws(() => validateNodeProductionStorage({ APP_ENV: "production", ARCHIVE_STORAGE_DRIVER: "local" }),
    /local kullanılamaz/);
});

test("geri yükleme doğrulayıcısı SQLite bütünlüğünü ve şema sürümünü kanıtlar", () => {
  const directory = mkdtempSync(join(tmpdir(), "arsiv-restore-"));
  const path = join(directory, "restore.db");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE schema_state (id TEXT PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO schema_state VALUES ('archive', 33)");
    db.close();
    assert.deepEqual(verifySqliteRestore(path, 33), { ok: true, failures: [] });
    assert.ok(verifySqliteRestore(path, 34).failures.includes("SCHEMA_VERSION_MISMATCH"));
    assert.ok(verifySqliteRestore(join(directory, "missing.db")).failures.includes("RESTORE_FILE_INVALID"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
