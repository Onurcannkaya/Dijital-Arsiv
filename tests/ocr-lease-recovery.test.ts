/**
 * Terk edilmiş OCR işinin kira ile kurtarılması — gerçek rota, gerçek şema,
 * gerçek SQLite.
 *
 * İş talebi tek koşullu UPDATE ile `status = 'processing'` yazar; talep eden
 * HTTP isteği dilim ortasında ölürse (işçi çökmesi, dağıtım, süreç ölümü) işi
 * kuyruğa döndürecek hiçbir yol yoktu. İş sonsuza dek 'processing' kalıyor,
 * elle tetikleme "hâlihazırda sürüyor" deyip dönüyordu; belge ancak
 * veritabanına elle dokunarak kurtarılabiliyordu. Aynı depodaki
 * `derivative_jobs` deseninde olduğu gibi talep artık bir kira sonu yazar.
 *
 * Bu testler kurtarmanın davranışını sabitler:
 * - kirası geçmiş 'processing' iş yeni tetiklemeyle yeniden talep edilir;
 * - kirası geçmemiş 'processing' iş edilemez ve servis hiç aranmaz;
 * - kolon eklenmeden önce takılı kalmış iş (boş kira) kendiliğinden kurtulur.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "kira@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": ADMIN };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const DOC = "terkedilmis-belge";

/** Tek sayfalık sonuç dönen OCR taklidi; gördüğü belgeleri kaydeder. */
function fakeOcr() {
  const seen: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { documentId?: string };
      if (parsed.documentId) seen.push(parsed.documentId);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        engine: "fake-ocr", model: "kira-1", durationMs: 5,
        pageCount: 1, pageFrom: 1, pageTo: 1, nextPage: null,
        accessDerivative: null, fields: [],
        pages: [{
          pageNumber: 1, width: 100, height: 140, rawText: "KARAR",
          fullText: "KARAR", averageConfidence: 0.9, words: [],
        }],
      }));
    });
  });
  return new Promise<{ url: string; seen: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`, seen,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Dilim ortasında ölmüş bir koşunun bıraktığı izi kurar: iş 'processing',
 * deneme sayacı tüketilmiş, belge de işlemede görünüyor. `leaseOffsetSeconds`
 * boş verilirse kolon eklenmeden önce takılı kalmış eski satır taklit edilir.
 */
async function seedAbandonedJob(server: NodeServer, leaseOffsetSeconds: number | null) {
  await server.db.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
       document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES (?, 'ARS-2026-KIRA', 'yarim-kalan.pdf', 'test/kira', 'application/pdf', 2048, ?,
      'Encümen karar sureti', ?, 'processing', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
    .bind(DOC, "f".repeat(64), UNIT, ADMIN).run();
  await server.db.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256, generator)
    VALUES ('obj-kira', ?, 'original', 'originals/kira/1', 'application/pdf', 2048, ?, 'test')`)
    .bind(DOC, "f".repeat(64)).run();
  await server.db.prepare(`INSERT INTO processing_jobs
      (id, document_id, kind, status, attempt, max_attempts, lease_expires_at, last_attempt_at)
    VALUES ('job-kira', ?, 'ocr', 'processing', 1, 3,
      CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ? || ' seconds') END, datetime('now', '-1 hour'))`)
    .bind(DOC, leaseOffsetSeconds, leaseOffsetSeconds).run();
}

async function withServer(ocrServiceUrl: string, run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: `.wrangler/tmp/kira-${Math.floor(performance.now() * 1000)}`,
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        OCR_SERVICE_URL: ocrServiceUrl,
        APP_ENV: "staging",
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

type ProcessResult = { processed?: boolean; completed?: boolean; message?: string };

const trigger = async (server: NodeServer, documentId?: string) => {
  const query = documentId ? `?documentId=${documentId}` : "";
  const response = await fetch(`${server.url}/api/jobs/process${query}`,
    { method: "POST", headers: IDENTITY });
  return { status: response.status, body: await response.json().catch(() => ({})) as ProcessResult };
};

const jobRow = (server: NodeServer) => server.db
  .prepare(`SELECT status, attempt, lease_expires_at FROM processing_jobs WHERE id = 'job-kira'`)
  .first<{ status: string; attempt: number; lease_expires_at: string | null }>();

test("kirası geçmiş 'processing' iş yeni tetiklemeyle kurtarılır", async () => {
  const ocr = await fakeOcr();
  try {
    await withServer(ocr.url, async (server) => {
      // Koşu 2 dakika önce ölmüş: kira geçmişte, iş hâlâ 'processing'.
      await seedAbandonedJob(server, -120);

      // Memurun yaptığı şey: belgenin sayfasında OCR düğmesine yeniden basmak.
      const result = await trigger(server, DOC);
      assert.equal(result.status, 200);
      assert.equal(result.body.processed, true,
        "kirası geçmiş iş yeniden talep edilemedi; belge kalıcı kilitli");
      assert.equal(result.body.completed, true);

      const job = await jobRow(server);
      assert.equal(job?.status, "completed");
      // Kurtarma bir denemedir: sayaç arıza bütçesinden düşer.
      assert.equal(job?.attempt, 2, "kurtarılan koşu deneme olarak sayılmadı");
      assert.equal(job?.lease_expires_at, null, "biten işin kirası temizlenmedi");
      assert.deepEqual(ocr.seen, [DOC]);

      const document = await server.db.prepare("SELECT status FROM archive_documents WHERE id = ?")
        .bind(DOC).first<{ status: string }>();
      assert.equal(document?.status, "review");
    });
  } finally {
    await ocr.close();
  }
});

test("kirası geçmemiş 'processing' iş talep edilemez ve servis aranmaz", async () => {
  const ocr = await fakeOcr();
  try {
    await withServer(ocr.url, async (server) => {
      // Yaşayan bir koşu: kira 10 dakika sonra dolacak.
      await seedAbandonedJob(server, 600);

      const result = await trigger(server, DOC);
      assert.equal(result.status, 200);
      assert.equal(result.body.processed, false, "yaşayan koşunun işi ikinci kez dağıtıldı");
      // Mesaj kiranın sonunu söyler: memur ne zaman yeniden basabileceğini bilir.
      assert.match(result.body.message ?? "", /hâlihazırda sürüyor/);
      assert.match(result.body.message ?? "", /yeniden tetiklenebilir/);

      const job = await jobRow(server);
      assert.equal(job?.status, "processing", "yaşayan koşunun durumu bozuldu");
      assert.equal(job?.attempt, 1, "talep edilmeyen iş deneme tüketti");
      assert.ok(job?.lease_expires_at, "yaşayan koşunun kirası silindi");
      assert.deepEqual(ocr.seen, [], "OCR servisi aynı belge için ikinci kez arandı");
    });
  } finally {
    await ocr.close();
  }
});

test("kolon eklenmeden önce takılı kalmış iş (boş kira) kendiliğinden kurtulur", async () => {
  const ocr = await fakeOcr();
  try {
    await withServer(ocr.url, async (server) => {
      // Göçten önceki dünya: 'processing' ama kira kolonu hiç yazılmamış.
      await seedAbandonedJob(server, null);

      // Cron süpürmesinin yaptığı şey: belge kimliği vermeden sıradaki işi istemek.
      const result = await trigger(server);
      assert.equal(result.status, 200);
      assert.equal(result.body.processed, true,
        "boş kira 'geçmiş' sayılmadı; eski takılı işler veri düzeltmesi bekler");
      assert.equal((await jobRow(server))?.status, "completed");
      assert.deepEqual(ocr.seen, [DOC]);
    });
  } finally {
    await ocr.close();
  }
});
