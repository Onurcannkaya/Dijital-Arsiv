import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const base = readFileSync(new URL("../deploy/kurum-ici/nginx.conf", import.meta.url), "utf8");
const sso = readFileSync(new URL("../deploy/kurum-ici/sso/nginx.sso.conf.template", import.meta.url), "utf8");
const tls = readFileSync(new URL("../deploy/kurum-ici/tls/nginx.tls.conf.template", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../deploy/kurum-ici/docker-compose.tls.yml", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/deploy-onprem.yml", import.meta.url), "utf8");
const edgeGuard = readFileSync(new URL("../deploy/kurum-ici/sso/validate-edge-env.sh", import.meta.url), "utf8");

test("nginx sınırları temel tarayıcı güvenlik başlıklarını her yanıta ekler", () => {
  for (const config of [base, sso]) {
    assert.match(config, /X-Content-Type-Options "nosniff" always/);
    assert.match(config, /X-Frame-Options "DENY" always/);
    assert.match(config, /Referrer-Policy "no-referrer" always/);
    assert.match(config, /Permissions-Policy/);
    assert.match(config, /Content-Security-Policy/);
  }
});

test("TLS kaplaması düz HTTP ana makine portunu kaldırır ve güçlü protokoller kullanır", () => {
  assert.match(overlay, /ports: !override \[\]/);
  assert.match(overlay, /ARCHIVE_TLS_CERT_FILE/);
  assert.match(overlay, /ARCHIVE_TLS_KEY_FILE/);
  assert.match(tls, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.match(tls, /Strict-Transport-Security/);
  assert.match(tls, /X-Forwarded-Proto https/);
});

test("kurum dağıtımı SSO ve TLS kaplamalarını atlayamaz", () => {
  assert.match(workflow, /docker-compose\.sso\.yml/);
  assert.match(workflow, /docker-compose\.tls\.yml/);
  assert.match(workflow, /ONPREM_REQUIRE_EDGE: enabled/);
  assert.match(sso, /X-Forwarded-Proto \$\{ARCHIVE_EXTERNAL_SCHEME\}/);
  assert.doesNotMatch(sso, /X-Forwarded-Proto \$http_x_forwarded_proto/);
});

test("kabul SSO bypass'ı yalnız staging'de açık, production'da fail-closed'dur", () => {
  assert.match(sso, /ARCHIVE_ACCEPTANCE_BYPASS_ENABLED/);
  assert.match(sso, /enabled:\$\{ACCEPTANCE_PROXY_TOKEN\}/);
  assert.match(edgeGuard, /production\)/);
  assert.match(edgeGuard, /production kabul geçidi kapalı olmalıdır/);
  assert.match(edgeGuard, /production kabul geçidi jetonu tanımlanamaz/);
});
