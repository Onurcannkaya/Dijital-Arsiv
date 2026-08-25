import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const policyPath = (name) => `deploy/kurum-ici/minio/policies/${name}.json`;

async function policy(name) {
  return JSON.parse(await read(policyPath(name)));
}

function actionsForResource(document, resource) {
  return new Set(document.Statement
    .filter((statement) => statement.Effect === "Allow" && statement.Resource.includes(resource))
    .flatMap((statement) => statement.Action));
}

test("kurum içi MinIO politikaları 2048 bayt sınırında ve dar kapsamlıdır", async () => {
  const names = ["archive-api", "content-scan-readonly", "ocr-original-readonly", "document-render"];
  for (const name of names) {
    const size = (await stat(new URL(policyPath(name), root))).size;
    assert.ok(size <= 2048, `${name} politikası MinIO 2048 bayt sınırını aşıyor: ${size}`);
  }

  const [api, scanner, ocr, renderer] = await Promise.all(names.map(policy));
  const original = actionsForResource(api, "arn:aws:s3:::arsiv-asil/*");
  assert.ok(original.has("s3:GetObject"));
  assert.ok(original.has("s3:PutObject"));
  for (const forbidden of [
    "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:BypassGovernanceRetention",
    "s3:PutObjectRetention", "s3:PutObjectLegalHold",
  ]) {
    assert.ok(!original.has(forbidden), `API asıl kasada ${forbidden} yetkisi almamalı`);
  }

  assert.deepEqual(
    new Set(scanner.Statement.flatMap((statement) => statement.Resource)),
    new Set(["arn:aws:s3:::arsiv-karantina", "arn:aws:s3:::arsiv-karantina/*"]),
  );
  assert.deepEqual(
    new Set(ocr.Statement.flatMap((statement) => statement.Resource)),
    new Set(["arn:aws:s3:::arsiv-asil", "arn:aws:s3:::arsiv-asil/*"]),
  );
  assert.deepEqual(
    new Set(renderer.Statement.flatMap((statement) => statement.Resource)),
    new Set([
      "arn:aws:s3:::arsiv-asil", "arn:aws:s3:::arsiv-turev",
      "arn:aws:s3:::arsiv-asil/*", "arn:aws:s3:::arsiv-turev/*",
    ]),
  );
  assert.ok(!actionsForResource(renderer, "arn:aws:s3:::arsiv-asil/*").has("s3:PutObject"));
  assert.ok(actionsForResource(renderer, "arn:aws:s3:::arsiv-turev/*").has("s3:PutObject"));
});

test("kurum içi compose WORM ve servis kimliği ayrımında fail-closed çalışır", async () => {
  const compose = await read("deploy/kurum-ici/docker-compose.yml");
  assert.match(compose, /mc version enable kurum\/arsiv-asil/);
  assert.match(compose, /mc retention set --default "\$\$\{ARCHIVE_WORM_RETENTION_MODE\}" "\$\$\{ARCHIVE_WORM_RETENTION_DURATION\}" kurum\/arsiv-asil/);
  assert.match(compose, /ARCHIVE_WORM_RETENTION_MODE[^\n]+COMPLIANCE/);
  assert.match(compose, /approved-production-policy/);
  assert.match(compose, /mc admin policy detach kurum readwrite/);
  assert.doesNotMatch(compose, /mc admin policy attach kurum readwrite/);
  assert.match(compose, /require_distinct/);
  assert.match(compose, /require_secret/);

  assert.match(compose, /content-scan:[\s\S]*?AWS_ACCESS_KEY_ID: \$\{CONTENT_SCAN_S3_ACCESS_KEY_ID:\?\}/);
  assert.match(compose, /ocr:[\s\S]*?AWS_ACCESS_KEY_ID: \$\{OCR_S3_ACCESS_KEY_ID:\?\}/);
  assert.match(compose, /document-render:[\s\S]*?AWS_ACCESS_KEY_ID: \$\{DOCUMENT_RENDER_S3_ACCESS_KEY_ID:\?\}/);
});

test("örnek ortam üretim onayı ile sentetik staging süresini ayırır", async () => {
  const env = await read("deploy/kurum-ici/.env.example");
  assert.match(env, /^APP_ENV=staging$/m);
  assert.match(env, /^ARCHIVE_WORM_RETENTION_MODE=COMPLIANCE$/m);
  assert.match(env, /^ARCHIVE_WORM_RETENTION_DURATION=1d$/m);
  assert.match(env, /^ARCHIVE_WORM_POLICY_APPROVED=$/m);
  for (const name of [
    "ARCHIVE_S3_ACCESS_KEY_ID", "CONTENT_SCAN_S3_ACCESS_KEY_ID",
    "OCR_S3_ACCESS_KEY_ID", "DOCUMENT_RENDER_S3_ACCESS_KEY_ID",
  ]) {
    assert.match(env, new RegExp(`^${name}=\\S+$`, "m"));
  }
});
