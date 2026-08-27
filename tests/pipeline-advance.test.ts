/**
 * Hızlı kabul sihirbazının motoru — `POST /api/pipeline/advance`.
 *
 * Rota, kabul hattını cron beklemeden sınırlı bir dilim ilerletir. Buradaki
 * testler rotanın KENDİ eklediği mantığı kanıtlar (tarama/terfi/OCR
 * işçilerinin iç doğruluğu kendi test dosyalarındadır):
 * - uç `document.upload` yetkisi ister; doğrulayıcı çağıramaz;
 * - kuyruklar boş ve servisler yapılandırılmamışken sayaçlar dürüstçe sıfırdır;
 * - OCR turu kuyruğun başını değil, ÇAĞIRAN memurun kendi EN YENİ bekleyen
 *   belgesini hedefler — toplu aktarım döneminde binlerce sayfalık ciltler
 *   yeni evrağı açlığa düşüremez;
 * - süren bir OCR işi varken yeni tetik atlanır (Paddle tek uçuşludur);
 * - `/api/admin/scan` yetki ister ve tarama servisi yapılandırılmamışsa 503
 *   ile açıkça söyler;
 * - `/api/health` PDF türev üreticisini de ölçer (kaynak düzeyi denetim).
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "yonetici@sivas.bel.tr";
const REVIEWER = "dogrulayici@sivas.bel.tr";
const CLERK = "memur@sivas.bel.tr";
const UNIT = "İmar ve Şehircilik Müdürlüğü";

/** Sahte OCR servisi: /health hazır der, /v1/ocr çağrıları sayar ve 500 döner. */
function startOcrStub(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let count = 0;
    const stub = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ modelReady: true }));
        return;
      }
      if (request.url === "/v1/ocr") {
        count += 1;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "stub: motor yok" }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    stub.listen(0, "127.0.0.1", () => {
      const address = stub.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        hits: () => count,
        close: () => new Promise((done) => { stub.close(() => done()); }),
      });
    });
  });
}

async function withServer(ocrUrl: string | null, run: (server: NodeServer) => Promise<void>, extraEnv: Record<string, string> = {}) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/pipeline-advance",
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        APP_ENV: "staging",
        ...(ocrUrl ? { OCR_SERVICE_URL: ocrUrl } : {}),
        ...extraEnv,
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    await server.db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES (?, 'Doğrulayıcı', 'reviewer', ?, 1)`).bind(REVIEWER, UNIT).run();
    await run(server);
  } finally {
    await server.close();
  }
}

function hex64(key: string) {
  return key.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "e").padEnd(64, "e");
}

/** Kuyrukta bekleyen OCR işiyle birlikte kabul edilmiş bir belge kurar. */
async function seedDocumentWithJob(server: NodeServer, options: { key: string; uploadedBy: string; createdAt: string }) {
  const id = `belge-${options.key}`;
  await server.db.prepare(`INSERT INTO archive_documents (id, reference_no, original_name, storage_key,
      media_type, byte_size, sha256, document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'application/pdf', 2048, ?, 'Tasnif bekliyor', ?, 'queued', ?, ?, ?)`)
    .bind(id, `ARS-2026-${options.key.toUpperCase()}`, `${options.key}.pdf`,
      `originals/${id}/nesne-${options.key}`, hex64(options.key), UNIT,
      options.uploadedBy, options.createdAt, options.createdAt).run();
  await server.db.prepare(`INSERT INTO binary_objects (id, document_id, object_class, object_key,
      storage_provider, bucket_or_namespace, media_type, byte_size, sha256, encryption_status, generator, created_at)
    VALUES (?, ?, 'original', ?, 'r2', 'ARCHIVE_FILES', 'application/pdf', 2048, ?, 'provider-managed', 'test', ?)`)
    .bind(`nesne-${options.key}`, id, `originals/${id}/nesne-${options.key}`, hex64(options.key), options.createdAt).run();
  await server.db.prepare(`INSERT INTO processing_jobs (id, document_id, kind, status, attempt,
      max_attempts, model, created_at, updated_at)
    VALUES (?, ?, 'ocr', 'queued', 0, 3, 'paddleocr-local', ?, ?)`)
    .bind(`is-${options.key}`, id, options.createdAt, options.createdAt).run();
  return { id, jobId: `is-${options.key}` };
}

async function jobState(server: NodeServer, jobId: string) {
  return server.db.prepare("SELECT status, attempt, error_message FROM processing_jobs WHERE id = ?")
    .bind(jobId).first<{ status: string; attempt: number; error_message: string | null }>();
}

test("kabul hattını ilerletmek yükleme yetkisi ister", async () => {
  await withServer(null, async (server) => {
    const response = await fetch(`${server.url}/api/pipeline/advance`, {
      method: "POST", headers: { "oai-authenticated-user-email": REVIEWER },
    });
    assert.equal(response.status, 403);
  });
});

test("kuyruklar boş ve servisler yapılandırılmamışken sayaçlar sıfırdır", async () => {
  await withServer(null, async (server) => {
    const response = await fetch(`${server.url}/api/pipeline/advance`, {
      method: "POST", headers: { "oai-authenticated-user-email": ADMIN },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { advanced?: { contentScans: number; promotions: number; ocr: number } };
    assert.deepEqual(payload.advanced, { contentScans: 0, promotions: 0, ocr: 0 });
  });
});

test("OCR turu kuyruğun başını değil memurun kendi en yeni belgesini hedefler", async () => {
  const stub = await startOcrStub();
  try {
    await withServer(stub.url, async (server) => {
      // Kuyruğun başı (en eski iş) BAŞKASININ cildi; memurun iki belgesi arkada.
      const foreign = await seedDocumentWithJob(server, { key: "c1", uploadedBy: CLERK, createdAt: "2026-08-01T09:00:00.000Z" });
      const mineOld = await seedDocumentWithJob(server, { key: "c2", uploadedBy: ADMIN, createdAt: "2026-08-10T09:00:00.000Z" });
      const mineNew = await seedDocumentWithJob(server, { key: "c3", uploadedBy: ADMIN, createdAt: "2026-08-19T09:00:00.000Z" });

      const response = await fetch(`${server.url}/api/pipeline/advance`, {
        method: "POST", headers: { "oai-authenticated-user-email": ADMIN },
      });
      assert.equal(response.status, 200);

      // Servis tam bir kez, memurun EN YENİ belgesi için çağrıldı; stub 500
      // verdiği için iş sayaç tüketerek kuyruğa döndü ve hata izi yazıldı.
      assert.equal(stub.hits(), 1, "OCR servisi tam bir kez çağrılmalı");
      const claimed = await jobState(server, mineNew.jobId);
      assert.equal(claimed?.attempt, 1);
      assert.match(claimed?.error_message ?? "", /500/);
      assert.equal((await jobState(server, mineOld.jobId))?.attempt, 0, "eski belge sıra çalmamalı");
      assert.equal((await jobState(server, foreign.jobId))?.attempt, 0, "başkasının cildi hedeflenmemeli");
    });
  } finally {
    await stub.close();
  }
});

test("süren OCR işi varken yeni tetik atlanır (tek uçuş)", async () => {
  const stub = await startOcrStub();
  try {
    await withServer(stub.url, async (server) => {
      const running = await seedDocumentWithJob(server, { key: "c4", uploadedBy: CLERK, createdAt: "2026-08-18T09:00:00.000Z" });
      await server.db.prepare("UPDATE processing_jobs SET status = 'processing' WHERE id = ?")
        .bind(running.jobId).run();
      const mine = await seedDocumentWithJob(server, { key: "c5", uploadedBy: ADMIN, createdAt: "2026-08-19T09:00:00.000Z" });

      const response = await fetch(`${server.url}/api/pipeline/advance`, {
        method: "POST", headers: { "oai-authenticated-user-email": ADMIN },
      });
      assert.equal(response.status, 200);
      assert.equal(stub.hits(), 0, "süren iş varken servis çağrılmamalı");
      assert.equal((await jobState(server, mine.jobId))?.attempt, 0);
    });
  } finally {
    await stub.close();
  }
});

test("sihirbaz yoklamasıyla azami denemeyi tüketen iş de alarma bağlanır", async () => {
  const ocrStub = await startOcrStub();
  const alerts: Array<Record<string, unknown>> = [];
  const alertStub = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { alerts.push(JSON.parse(body) as Record<string, unknown>); response.writeHead(200); response.end(); });
  });
  await new Promise<void>((resolve) => { alertStub.listen(0, "127.0.0.1", () => resolve()); });
  const alertUrl = `http://127.0.0.1:${(alertStub.address() as { port: number }).port}`;
  try {
    await withServer(ocrStub.url, async (server) => {
      // Son hakkını kullanacak iş: bir sonraki arıza dead-letter demektir.
      const doomed = await seedDocumentWithJob(server, { key: "c6", uploadedBy: ADMIN, createdAt: "2026-08-20T09:00:00.000Z" });
      await server.db.prepare("UPDATE processing_jobs SET attempt = 2 WHERE id = ?").bind(doomed.jobId).run();

      const response = await fetch(`${server.url}/api/pipeline/advance`, {
        method: "POST", headers: { "oai-authenticated-user-email": ADMIN },
      });
      assert.equal(response.status, 200, "OCR arızası advance turunu düşürmez");

      const job = await jobState(server, doomed.jobId);
      assert.equal(job?.status, "failed", "iş dead-letter'a düşmeli");
      // Alarm cron'u beklemeden, olayın kaynağından gitti.
      assert.equal(alerts.length, 1, "dead-letter alarmı advance yolunda da atılmalı");
      assert.equal(alerts[0].event, "ocr.dead-letter");
      assert.equal(alerts[0].severity, "critical");
      assert.equal((alerts[0].detail as { documentId: string }).documentId, doomed.id);
    }, { ALARM_WEBHOOK_URL: alertUrl });
  } finally {
    await ocrStub.close();
    await new Promise<void>((resolve) => { alertStub.close(() => resolve()); });
  }
});

test("tarama turu yönetim yetkisi ister; servis yapılandırılmamışsa açıkça söyler", async () => {
  await withServer(null, async (server) => {
    const forbidden = await fetch(`${server.url}/api/admin/scan`, {
      method: "POST", headers: { "oai-authenticated-user-email": REVIEWER },
    });
    assert.equal(forbidden.status, 403);

    const unconfigured = await fetch(`${server.url}/api/admin/scan`, {
      method: "POST", headers: { "oai-authenticated-user-email": ADMIN },
    });
    assert.equal(unconfigured.status, 503);
    const payload = await unconfigured.json() as { error?: string };
    assert.match(payload.error ?? "", /CONTENT_SCAN_SERVICE_URL/);
  });
});

test("readiness denetimi PDF türev üreticisini de ölçer", async () => {
  const source = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  assert.match(source, /DOCUMENT_RENDER_SERVICE_URL/);
  assert.match(source, /documentRender/);
  // Yapılandırılmamış servis görünür kalır ama readiness'i düşürmez; üretimde
  // sırrı wrangler zorunlu kılar, yerel geliştirme türevsiz çalışabilir.
  assert.match(source, /renderUrl \? documentRender\.ok : true/);
  assert.match(source, /configured: false/);
  assert.match(source, /state\.rendererImageDigest !== bindings\.DOCUMENT_RENDER_IMAGE_DIGEST\.toLowerCase\(\)/);
  assert.match(source, /state\.profileVersion !== "access-pdf-v1"/);
});
