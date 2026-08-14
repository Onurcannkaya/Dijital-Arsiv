/**
 * Yerel zincir onarımının güvenceleri — gerçek rotalar, gerçek şema, SQLite.
 *
 * F1.3 nesne-referanslı servis çağrısına geçtiğinden beri yerel zincir
 * kopuktu ve iki gerçek kusuru gizliyordu; ikisi de burada davranışla
 * sabitlenir:
 *
 * 1. OCR rotası erişim türevini ASIL KASAYA yazıp öyle kaydediyordu; bilet ve
 *    dosya sunumu ise ADR-014 gereği türevi yalnız DERIVATIVE_FILES altında
 *    arar. Yazanla okuyan farklı yer söylediği için önizleme, türev üretilmiş
 *    olsa bile hiç açılamıyordu.
 * 2. Yerel geliştirme için eklenen iç nesne okuma ucu üç kilitle kapalıdır:
 *    bayrak, kapsam başına servis jetonu, önek + yol geçişi denetimi.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "zincir@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": ADMIN };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const OCR_TOKEN = "ocr-jetonu-yerel-test";
const SCAN_TOKEN = "tarama-jetonu-yerel-test";

/** Geçerli sözleşmeyle yanıt veren küçük OCR taklidi; türev de döndürür. */
function fakeOcrService() {
  // Sözleşme türev olarak yalnız image/jpeg kabul eder; içerik önemsizdir,
  // rota baytları doğrulamadan koyar (görüntü doğrulaması OCR servisindedir).
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        engine: "fake-ocr", model: "test-1", durationMs: 5,
        pages: [{ pageNumber: 1, width: 100, height: 100, rawText: "KARAR 538",
          fullText: "KARAR 538", averageConfidence: 0.95, words: [] }],
        fields: [],
        // Tek sayfalık görüntü: dilim baştan sona kapanır, kalan sayfa yoktur.
        pageCount: 1, pageFrom: 1, pageTo: 1, nextPage: null,
        accessDerivative: { mediaType: "image/jpeg", byteSize: jpeg.byteLength, base64: jpeg.toString("base64") },
      }));
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function withServer(extraEnv: Record<string, string>, run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: `.wrangler/tmp/zincir-${Math.floor(performance.now() * 1000)}`,
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        APP_ENV: "staging",
        ...extraEnv,
      },
    },
    host: "127.0.0.1", port: 0, scheduler: false,
  });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

async function seedOcrReadyDocument(server: NodeServer, id: string) {
  await server.db.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
       document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, 'karar.jpeg', ?, 'image/jpeg', 2048, ?, 'Encümen karar sureti', ?, 'queued', ?,
      '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
    .bind(id, `ARS-2026-${id.toUpperCase()}`, `test/${id}`, "b".repeat(64), UNIT, ADMIN).run();
  await server.db.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256, generator)
    VALUES (?, ?, 'original', ?, 'image/jpeg', 2048, ?, 'test')`)
    .bind(`obj-${id}`, id, `originals/${id}/1`, "b".repeat(64)).run();
  await server.db.prepare(`INSERT INTO processing_jobs (id, document_id, kind, status, attempt, max_attempts)
    VALUES (?, ?, 'ocr', 'queued', 0, 3)`).bind(`job-${id}`, id).run();
}

test("erişim türevi asıl kasaya değil kendi deposuna yazılır", async () => {
  const ocr = await fakeOcrService();
  try {
    await withServer({ OCR_SERVICE_URL: ocr.url }, async (server) => {
      await seedOcrReadyDocument(server, "turev-belge");
      const response = await fetch(`${server.url}/api/jobs/process?documentId=turev-belge`,
        { method: "POST", headers: IDENTITY });
      const body = await response.json() as { processed?: boolean; accessDerivative?: boolean };
      assert.equal(response.status, 200);
      assert.equal(body.accessDerivative, true, "türev üretilmedi");

      /*
       * Kayıt DERIVATIVE_FILES demeli: bilet verme ve dosya sunma yalnız o
       * ad alanındaki erişim türevine bağlanır. ARCHIVE_FILES yazıldığında
       * önizleme, türev var olduğu hâlde "uygun güvenli nesne bulunamadı"
       * ile ölür — yerel zincirde yaşanan buydu.
       */
      const derivative = await server.db.prepare(`SELECT bucket_or_namespace, object_key
          FROM binary_objects WHERE document_id = 'turev-belge' AND object_class = 'access'`)
        .first<{ bucket_or_namespace: string; object_key: string }>();
      assert.ok(derivative, "türev kaydı yok");
      assert.equal(derivative.bucket_or_namespace, "DERIVATIVE_FILES");

      // Ve görüntüleme bileti artık gerçekten verilebilmeli (425 değil).
      const ticket = await fetch(`${server.url}/api/documents/turev-belge/access-ticket`, {
        method: "POST", headers: { ...IDENTITY, "content-type": "application/json" },
        body: JSON.stringify({ scope: "VIEW", purpose: "DOCUMENT_REVIEW" }),
      });
      assert.equal(ticket.status, 201, "türev varken görüntüleme bileti verilemedi");
    });
  } finally {
    await ocr.close();
  }
});

test("iç nesne okuma ucu üç kilitle kapalıdır", async () => {
  // Kilit 1: bayrak yokken uç, bilinmeyen rotadan ayırt edilemez.
  await withServer({ OCR_SERVICE_TOKEN: OCR_TOKEN }, async (server) => {
    const off = await fetch(`${server.url}/api/internal/objects?scope=original&key=originals/x`,
      { headers: { authorization: `Bearer ${OCR_TOKEN}` } });
    assert.equal(off.status, 404);
  });

  await withServer({
    ARCHIVE_INTERNAL_OBJECT_FETCH: "enabled",
    OCR_SERVICE_TOKEN: OCR_TOKEN,
    CONTENT_SCAN_SERVICE_TOKEN: SCAN_TOKEN,
  }, async (server) => {
    const get = (query: string, token?: string) => fetch(`${server.url}/api/internal/objects?${query}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} });

    // Kilit 2: kapsam başına ayrı jeton — tarama jetonu asıl kasayı açamaz.
    assert.equal((await get("scope=original&key=originals/x")).status, 403);
    assert.equal((await get("scope=original&key=originals/x", SCAN_TOKEN)).status, 403);
    assert.equal((await get("scope=quarantine&key=quarantine/x", OCR_TOKEN)).status, 403);

    // Kilit 3: önek ve yol geçişi — uç keyfî anahtar okuyan vekile dönüşemez.
    assert.equal((await get("scope=original&key=quarantine/x", OCR_TOKEN)).status, 400);
    assert.equal((await get("scope=original&key=originals/../gizli", OCR_TOKEN)).status, 400);
    assert.equal((await get("scope=bilinmeyen&key=originals/x", OCR_TOKEN)).status, 404);

    // Doğru jeton + doğru kapsam: gerçek baytlar döner.
    const payload = new TextEncoder().encode("karantina icerigi");
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", payload))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const created = await fetch(`${server.url}/api/uploads`, {
      method: "POST",
      headers: { ...IDENTITY, "content-type": "application/json", "idempotency-key": "ic-uc-1" },
      body: JSON.stringify({ unit: UNIT, byteSize: payload.byteLength,
        mediaType: "application/pdf", originalName: "ic.pdf" }),
    });
    const sessionId = ((await created.json()) as { session: { id: string } }).session.id;
    await fetch(`${server.url}/api/uploads/${sessionId}/parts`, {
      method: "PUT",
      headers: { ...IDENTITY, "x-part-number": "1", "x-content-sha256": sha,
        "content-type": "application/octet-stream" },
      body: payload,
    });
    await fetch(`${server.url}/api/uploads/${sessionId}/complete`,
      { method: "POST", headers: { ...IDENTITY, "content-type": "application/json" }, body: "{}" });

    const object = await get(`scope=quarantine&key=quarantine/${sessionId}/payload`, SCAN_TOKEN);
    assert.equal(object.status, 200);
    const bytes = new Uint8Array(await object.arrayBuffer());
    assert.equal(bytes.byteLength, payload.byteLength);
    assert.deepEqual([...bytes], [...payload], "dönen baytlar karantinadakiyle aynı değil");
  });
});
