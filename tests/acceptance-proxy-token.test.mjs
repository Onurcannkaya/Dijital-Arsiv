/**
 * F1.11/P5 — SSO vekili sentetik kimlik geçidi jetonu.
 *
 * Kurum içi staging SSO vekilinin arkasındayken yürütücü istemcisi
 * `x-acceptance-proxy-token` başlığını göndermelidir; jeton yoksa ya da
 * kısaysa başlık hiç gönderilmez (Cloudflare pilotu vekilsizdir).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createAppClient } from "../scripts/acceptance-executors/contract.mjs";

function capturingFetcher(captured) {
  return async (url, init) => {
    captured.push({ url: String(url), headers: init.headers ?? {} });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
}

const BASE = {
  baseUrl: "https://staging.example",
  identity: "kabul@sivas.bel.tr",
};

test("geçerli jeton bütün istek türlerinde başlık olarak taşınır", async () => {
  const captured = [];
  const client = createAppClient({
    ...BASE,
    proxyToken: "j".repeat(40),
    fetcher: capturingFetcher(captured),
  });
  await client.json("GET", "/api/uploads?id=x");
  await client.putPart("/api/uploads/x/parts", {
    partNumber: 1, sha256: "a".repeat(64), bytes: new Uint8Array([1]),
  });
  await client.getBytes("/api/documents/d/file");
  assert.equal(captured.length, 3);
  for (const request of captured) {
    assert.equal(request.headers["x-acceptance-proxy-token"], "j".repeat(40));
    assert.equal(request.headers["oai-authenticated-user-email"], "kabul@sivas.bel.tr");
  }
});

test("jeton yoksa ya da 32 karakterden kısaysa başlık gönderilmez", async () => {
  for (const proxyToken of [undefined, "", "kisa-jeton"]) {
    const captured = [];
    const client = createAppClient({ ...BASE, proxyToken, fetcher: capturingFetcher(captured) });
    await client.json("GET", "/api/uploads?id=x");
    assert.ok(!("x-acceptance-proxy-token" in captured[0].headers),
      `jeton "${proxyToken}" başlık üretmemeli`);
  }
});
