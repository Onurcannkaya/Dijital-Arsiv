/**
 * Bekleyen yüklemeler listesinin güvenceleri.
 *
 * Belge kaydı tarama + terfi sonrası doğar (F1.5); o ana kadar yükleme hiçbir
 * listede görünmüyordu ve "karantinaya alındı" mesajından sonra memur kaybolmuş
 * bir dosyaya bakıyordu — yerelde cron da ateşlenmediği için sonsuza dek.
 * Kimliksiz GET /api/uploads, kullanıcının KENDİ oturumlarını son durumuyla
 * listeler; terminal sonuçlar (mükerrer, ret) nedenleriyle görünür.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const STAFF = "bekleyen@sivas.bel.tr";
const OTHER = "baskasi@sivas.bel.tr";
const UNIT = "İmar ve Şehircilik Müdürlüğü";

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/bekleyen",
        ARCHIVE_ADMIN_EMAILS: `${STAFF},${OTHER}`,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1", port: 0, scheduler: false,
  });
  try { await run(server); } finally { await server.close(); }
}

async function uploadQuarantined(server: NodeServer, user: string, name: string) {
  const payload = new TextEncoder().encode(`icerik-${name}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const headers = { "oai-authenticated-user-email": user };
  const created = await fetch(`${server.url}/api/uploads`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": `bekleyen-${name}` },
    body: JSON.stringify({ unit: UNIT, byteSize: payload.byteLength, mediaType: "application/pdf", originalName: name }),
  });
  const session = ((await created.json()) as { session: { id: string } }).session;
  await fetch(`${server.url}/api/uploads/${session.id}/parts`, {
    method: "PUT",
    headers: { ...headers, "x-part-number": "1", "x-content-sha256": sha, "content-type": "application/octet-stream" },
    body: payload,
  });
  await fetch(`${server.url}/api/uploads/${session.id}/complete`,
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
  return session.id;
}

test("kimliksiz GET kendi oturumlarını durumuyla listeler; başkasınınkini sızdırmaz", async () => {
  await withServer(async (server) => {
    const own = await uploadQuarantined(server, STAFF, "kendi.pdf");
    await uploadQuarantined(server, OTHER, "yabanci.pdf");

    const response = await fetch(`${server.url}/api/uploads`,
      { headers: { "oai-authenticated-user-email": STAFF } });
    assert.equal(response.status, 200);
    const { sessions } = await response.json() as { sessions: Array<{
      id: string; originalName: string; status: string; failureCode: string | null }> };

    assert.equal(sessions.length, 1, "yalnız kendi oturumu listelenmeli");
    assert.equal(sessions[0].id, own);
    assert.equal(sessions[0].originalName, "kendi.pdf");
    // Tarama servisi yokken tamamlanan yükleme karantinada bekler; liste
    // tam da bu bekleyişi görünür kılar.
    assert.equal(sessions[0].status, "QUARANTINED");
  });
});
