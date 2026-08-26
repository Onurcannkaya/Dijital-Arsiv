import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const base = readFileSync(new URL("../deploy/kurum-ici/docker-compose.yml", import.meta.url), "utf8");
const sso = readFileSync(new URL("../deploy/kurum-ici/docker-compose.sso.yml", import.meta.url), "utf8");
const tls = readFileSync(new URL("../deploy/kurum-ici/docker-compose.tls.yml", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("uzun ömürlü servisler çöküşte yeniden başlar ve ayrıcalık yükseltemez", () => {
  assert.match(base, /x-service-resilience:[\s\S]*restart: unless-stopped/);
  assert.match(base, /x-app-security:[\s\S]*cap_drop:\s*\n\s*- ALL/);
  assert.match(base, /no-new-privileges:true/);
  for (const overlay of [sso, tls]) {
    assert.match(overlay, /restart: unless-stopped/);
    assert.match(overlay, /no-new-privileges:true/);
  }
  assert.doesNotMatch(`${base}\n${sso}\n${tls}`, /privileged:\s*true/);
  assert.doesNotMatch(`${base}\n${sso}\n${tls}`, /docker\.sock/);
});

test("her ağır servis açık CPU, bellek ve süreç üst sınırı taşır", () => {
  for (const prefix of ["MINIO", "API", "CONTENT_SCAN", "OCR", "DOCUMENT_RENDER", "UI", "PROXY", "LITESTREAM"]) {
    assert.match(base, new RegExp(`\\$\\{${prefix}_MEMORY_LIMIT:-`));
    assert.match(base, new RegExp(`\\$\\{${prefix}_CPU_LIMIT:-`));
  }
  assert.match(sso, /OAUTH2_PROXY_MEMORY_LIMIT/);
  assert.match(tls, /TLS_EDGE_MEMORY_LIMIT/);
  assert.match(base, /--limit-max-requests.*\$\{OCR_MAX_REQUESTS:-100\}/);
});

test("API ve sırsız UI salt-okunur kök üzerinde yalnız sınırlı geçici alan kullanır", () => {
  assert.match(base, /api:[\s\S]*?read_only: true[\s\S]*?\/tmp:rw,noexec,nosuid,nodev,size=256m/);
  assert.match(base, /ui:[\s\S]*?read_only: true[\s\S]*?\/tmp:rw,noexec,nosuid,nodev,size=64m/);
  assert.match(ci, /config --no-interpolate --quiet/);
  assert.match(ci, /--read-only/);
  assert.match(ci, /sivas-arsiv-ui:ci/);
});
