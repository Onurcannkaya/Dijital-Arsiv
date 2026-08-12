/**
 * Kurum içi port P4 — Node sunucusunda uçtan uca kabul akışı.
 *
 * Gerçek rota modülleri, gerçek şema göçleri, üretim SQLite sarmalayıcısı ve
 * S3/MinIO adaptörleri birlikte, gerçek bir HTTP dinleyicisinin arkasında
 * koşar: oturum aç → parça yükle → tamamla → karantina nesnesi sahte MinIO
 * kovasına düşer. Bu, pilotun Cloudflare'siz çalışabildiğinin fiziksel
 * kanıtıdır; tarama/terfi sonrası adımlar dış servis istediğinden kapsam
 * dışıdır (kurum içi kabul koşusu F1.11 ile kanıtlanır).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;
const { fakeS3Server } = await import("./node-s3-fake.ts");

const UPLOADER = "kurum-ici@sivas.bel.tr";
const UNIT = "Yazı İşleri Müdürlüğü";

function buckets() {
  return {
    "arsiv-asil": fakeS3Server({ bucket: "arsiv-asil" }),
    "arsiv-turev": fakeS3Server({ bucket: "arsiv-turev" }),
    "arsiv-gecici": fakeS3Server({ bucket: "arsiv-gecici" }),
    "arsiv-karantina": fakeS3Server({ bucket: "arsiv-karantina" }),
  };
}

function multiBucketFetcher(servers: ReturnType<typeof buckets>): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    const bucket = decodeURIComponent(new URL(String(url)).pathname.split("/").filter(Boolean)[0] ?? "");
    const server = servers[bucket as keyof typeof servers];
    if (!server) {
      return Promise.resolve(new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }));
    }
    return server.fetcher(String(url), init);
  }) as typeof fetch;
}

async function withServer(run: (server: NodeServer, servers: ReturnType<typeof buckets>) => Promise<void>) {
  const servers = buckets();
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      fetcher: multiBucketFetcher(servers),
      env: {
        ARCHIVE_S3_ENDPOINT: "https://minio.internal",
        ARCHIVE_S3_ACCESS_KEY_ID: "uygulama",
        ARCHIVE_S3_SECRET_ACCESS_KEY: "s".repeat(24),
        ARCHIVE_S3_BUCKET_ARCHIVE: "arsiv-asil",
        ARCHIVE_S3_BUCKET_DERIVATIVE: "arsiv-turev",
        ARCHIVE_S3_BUCKET_TEMPORARY: "arsiv-gecici",
        ARCHIVE_S3_BUCKET_QUARANTINE: "arsiv-karantina",
        ARCHIVE_ADMIN_EMAILS: UPLOADER,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    await run(server, servers);
  } finally {
    await server.close();
  }
}

test("kabul akışı Node sunucusunda uçtan uca karantinaya ulaşır", async () => {
  await withServer(async (server, servers) => {
    // Sağlık: veritabanı + nesne deposu ayakta; dış servisler yokken degraded.
    const health = await fetch(`${server.url}/api/health`);
    const healthBody = await health.json() as {
      status: string;
      checks: Record<string, { ok: boolean }>;
    };
    assert.equal(health.status, 503);
    assert.equal(healthBody.status, "degraded");
    assert.equal(healthBody.checks.database.ok, true);
    assert.equal(healthBody.checks.objectStorage.ok, true);
    assert.equal(healthBody.checks.schema.ok, true);

    // Kimliksiz istek korumalı uçta reddedilir; /api dışı yol 404 döner.
    const anonymous = await fetch(`${server.url}/api/documents`);
    assert.equal(anonymous.status, 401);
    assert.equal((await fetch(`${server.url}/olmayan-sayfa`)).status, 404);

    // Kabul oturumu: aç → parça yükle → tamamla.
    const payload = new TextEncoder().encode("kurum ici ilk kabul belgesi");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const identity = { "oai-authenticated-user-email": UPLOADER };

    const created = await fetch(`${server.url}/api/uploads`, {
      method: "POST",
      headers: { ...identity, "content-type": "application/json", "idempotency-key": "node-e2e-1" },
      body: JSON.stringify({
        unit: UNIT,
        byteSize: payload.byteLength,
        mediaType: "application/pdf",
        originalName: "kurum-ici-e2e.pdf",
      }),
    });
    assert.equal(created.status, 201);
    const session = (await created.json() as { session: { id: string; status: string } }).session;
    assert.equal(session.status, "UPLOADING");

    const part = await fetch(`${server.url}/api/uploads/${session.id}/parts`, {
      method: "PUT",
      headers: {
        ...identity,
        "x-part-number": "1",
        "x-content-sha256": sha256,
        "content-type": "application/octet-stream",
      },
      body: payload,
    });
    assert.equal(part.status, 200, await part.text().catch(() => ""));

    const completed = await fetch(`${server.url}/api/uploads/${session.id}/complete`, {
      method: "POST",
      headers: { ...identity, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(completed.status, 200);
    const completedSession = (await completed.json() as {
      session: { status: string; sha256?: string };
    }).session;
    assert.equal(completedSession.status, "QUARANTINED");
    assert.equal(completedSession.sha256, sha256);

    // Fiziksel kanıt: karantina nesnesi sahte MinIO kovasında, geçici temizlendi.
    const quarantineKeys = [...servers["arsiv-karantina"].objects.keys()];
    assert.deepEqual(quarantineKeys, [`quarantine/${session.id}/payload`]);
    assert.equal(servers["arsiv-gecici"].objects.size, 0);

    // Oturum görünümü terminal-öncesi doğru durumu bildirir.
    const polled = await fetch(`${server.url}/api/uploads?id=${session.id}`, { headers: identity });
    assert.equal(polled.status, 200);
    assert.equal((await polled.json() as { session: { status: string } }).session.status, "QUARANTINED");
  });
});

test("aynı idempotency anahtarı Node sunucusunda oturumu devralır", async () => {
  await withServer(async (server) => {
    const identity = { "oai-authenticated-user-email": UPLOADER };
    const body = JSON.stringify({
      unit: UNIT,
      byteSize: 64,
      mediaType: "application/pdf",
      originalName: "devralma.pdf",
    });
    const first = await fetch(`${server.url}/api/uploads`, {
      method: "POST",
      headers: { ...identity, "content-type": "application/json", "idempotency-key": "node-e2e-resume" },
      body,
    });
    assert.equal(first.status, 201);
    const firstSession = (await first.json() as { session: { id: string } }).session;

    const second = await fetch(`${server.url}/api/uploads`, {
      method: "POST",
      headers: { ...identity, "content-type": "application/json", "idempotency-key": "node-e2e-resume" },
      body,
    });
    assert.equal(second.status, 200);
    const resumed = (await second.json() as { session: { id: string; resumed: boolean } }).session;
    assert.equal(resumed.id, firstSession.id);
    assert.equal(resumed.resumed, true);
  });
});
