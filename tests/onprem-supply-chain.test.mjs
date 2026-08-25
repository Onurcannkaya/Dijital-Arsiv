import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const deploy = readFileSync(new URL("../.github/workflows/deploy-onprem.yml", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const compose = readFileSync(new URL("../deploy/kurum-ici/docker-compose.yml", import.meta.url), "utf8");
const ssoCompose = readFileSync(new URL("../deploy/kurum-ici/docker-compose.sso.yml", import.meta.url), "utf8");
const tlsCompose = readFileSync(new URL("../deploy/kurum-ici/docker-compose.tls.yml", import.meta.url), "utf8");
const runtimeGate = readFileSync(new URL("../scripts/validate-onprem-runtime-env.mjs", import.meta.url), "utf8");

test("dağıtılan beş imaj SBOM üretimi ve giderilebilir kritik açık kapısından geçer", () => {
  assert.match(deploy, /anchore\/sbom-action\/download-syft@[a-f0-9]{40}/);
  assert.match(deploy, /anchore\/scan-action\/download-grype@[a-f0-9]{40}/);
  assert.match(deploy, /spdx-json=outputs\/onprem\/\$\{name\}\.spdx\.json/);
  assert.match(deploy, /--fail-on critical --only-fixed/);
  assert.match(deploy, /\$\{name\}\.vulnerabilities\.json/);
  assert.match(deploy, /path: outputs\/onprem\//);
  assert.doesNotMatch(deploy, /aquasecurity\/trivy-action/);
});

test("ana CI üç Python servis testini çalıştırır ve action etiketleri hareketli değildir", () => {
  for (const service of ["content-scan", "ocr", "document-render"]) {
    assert.match(ci, new RegExp(`cd services/${service}`));
  }
  for (const line of ci.split(/\r?\n/).filter((entry) => entry.includes("uses:"))) {
    assert.match(line, /@[a-f0-9]{40}(?:\s+#|\s*$)/, `hareketli action referansı: ${line.trim()}`);
  }
});

test("korumalı ortamda üçüncü taraf çalışma imajları özetle sabitlenir", () => {
  for (const name of [
    "MINIO_SERVER_IMAGE",
    "MINIO_CLIENT_IMAGE",
    "NGINX_IMAGE",
    "LITESTREAM_IMAGE",
  ]) assert.match(compose, new RegExp(`\\$\\{${name}:-`));
  assert.match(ssoCompose, /\$\{OAUTH2_PROXY_IMAGE:-/);
  assert.match(tlsCompose, /\$\{NGINX_IMAGE:-/);
  assert.match(runtimeGate, /EXTERNAL_IMAGE_NOT_IMMUTABLE/);
  assert.match(runtimeGate, /@sha256:/);
});
