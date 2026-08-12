/**
 * OCR yeniden işleme akışı — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * OCR servisi ayakta değilken çalıştırılan iş, personelin göreceği tek
 * geri bildirimdir. "Beklenmeyen iç hata" diye bildirilirse memur belgede bir
 * sorun olduğunu sanır ve tekrar tekrar dener; oysa yapılacak iş servisi
 * ayağa kaldırmaktır. Servise ulaşılamaması işletimin tanıdığı bir durumdur,
 * korelasyon kimliğine gömülmemelidir.
 *
 * Kapsanan kabuller:
 * - erişilemeyen servis 503 ve eyleme yönlendiren gerekçe döner;
 * - aynı gerekçe işin kaydına yazılır (korelasyon kimliği değil);
 * - yanıt VEREN ama hata döndüren servis bu daldan ayrılır — o zaman sebep
 *   belgede ya da servisin kendi içinde olabilir;
 * - deneme sayacı ilerler ve azami denemede iş dead-letter'a düşer.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const STAFF = "ocr@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": STAFF };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const DOC = "ocr-yeniden";

/** Bağlanılamayan bir adres: kapalı bir port yerine ayrılmış TEST-NET-1 bloğu. */
const UNREACHABLE = "http://127.0.0.1:9";

async function withServer(ocrServiceUrl: string, run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/ocr-yeniden",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        OCR_SERVICE_URL: ocrServiceUrl,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    // OCR bekleyen bir belge ve asıl nesnesi; iş kaydı kuyrukta başlar.
    await server.db.prepare(`INSERT INTO archive_documents
        (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
         document_type, unit, status, uploaded_by, created_at, updated_at)
      VALUES (?, 'ARS-2026-OCR', 'tarama.pdf', 'test/ocr', 'application/pdf', 2048, ?,
        'Tasnif bekliyor', ?, 'queued', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
      .bind(DOC, "d".repeat(64), UNIT, STAFF).run();
    await server.db.prepare(`INSERT INTO binary_objects
        (id, document_id, object_class, object_key, media_type, byte_size, sha256, generator)
      VALUES ('obj-ocr', ?, 'original', 'originals/ocr/1', 'application/pdf', 2048, ?, 'test')`)
      .bind(DOC, "d".repeat(64)).run();
    await server.db.prepare(`INSERT INTO processing_jobs
        (id, document_id, kind, status, attempt, max_attempts)
      VALUES ('job-ocr', ?, 'ocr', 'queued', 0, 3)`).bind(DOC).run();
    await run(server);
  } finally {
    await server.close();
  }
}

const runOcr = async (server: NodeServer) => {
  const response = await fetch(`${server.url}/api/jobs/process?documentId=${DOC}`,
    { method: "POST", headers: IDENTITY });
  return { status: response.status, body: await response.json().catch(() => null) as { error?: string } };
};

const jobRow = (server: NodeServer) => server.db
  .prepare("SELECT status, attempt, error_message, dead_lettered_at FROM processing_jobs WHERE id = 'job-ocr'")
  .first<{ status: string; attempt: number; error_message: string | null; dead_lettered_at: string | null }>();

test("erişilemeyen OCR servisi eyleme yönlendiren gerekçeyle bildirilir", async () => {
  await withServer(UNREACHABLE, async (server) => {
    const failed = await runOcr(server);
    assert.equal(failed.status, 503);
    assert.match(failed.body.error ?? "", /OCR servisine ulaşılamıyor/);
    // Belgenin suçlanmaması, memurun nereye bakacağını bilmesi için önemlidir.
    assert.match(failed.body.error ?? "", /belgede sorun yok/);
    // Korelasyon kimliği beklenmeyen iç hatalar içindir; bu durum beklenendir.
    assert.doesNotMatch(failed.body.error ?? "", /olay kimliği|reference =/);

    // Aynı gerekçe işin kaydına da yazılmalı: işletim geçmişe bakıp neyin
    // olduğunu görebilmeli, opak bir dizeyle karşılaşmamalı.
    const job = await jobRow(server);
    assert.match(job?.error_message ?? "", /OCR servisine ulaşılamıyor/);
    assert.equal(job?.attempt, 1);
  });
});

test("geri çekilme penceresinde tetikleme başarı diye bildirilmez", async () => {
  await withServer(UNREACHABLE, async (server) => {
    assert.equal((await runOcr(server)).status, 503);
    const scheduled = await jobRow(server);
    assert.equal(scheduled?.attempt, 1);

    /*
     * Başarısız koşudan sonra iş geri çekilme penceresine alınır ve o pencerede
     * elle tetiklenemez. İstek 200 döner ama `processed` YANLIŞTIR: bunu başarı
     * saymak personele "OCR sonucu kaydedildi" dedirtir, oysa hiçbir şey
     * işlenmemiştir ve memur metnin neden gelmediğini arar.
     */
    const throttled = await runOcr(server);
    assert.equal(throttled.status, 200);
    const body = throttled.body as { processed?: boolean; message?: string };
    assert.equal(body.processed, false);
    // Genel "bekleyen iş yok" değil, o belgeye dair sebep dönmelidir.
    assert.match(body.message ?? "", /yeniden denenecek/);
    assert.doesNotMatch(body.message ?? "", /^Bekleyen OCR işi yok\.$/);

    // Sayaç boşa artmamalı: tetiklenmeyen istek denemeyi tüketmez.
    const after = await jobRow(server);
    assert.equal(after?.attempt, 1);
  });
});

test("elle yeniden işleme başarısız işi yeni bir döngüye alır", async () => {
  await withServer(UNREACHABLE, async (server) => {
    // Denemeleri tükenmiş, dead-letter'a düşmüş bir iş.
    await server.db.prepare(`UPDATE processing_jobs SET status = 'failed', attempt = 3,
      dead_lettered_at = CURRENT_TIMESTAMP, next_attempt_at = NULL WHERE id = 'job-ocr'`).run();

    // İşletim elle tetiklediğinde sayaç sıfırlanır: yeni bir deneme döngüsü
    // başlar, aksi halde dead-letter'daki iş bir daha hiç çalıştırılamazdı.
    assert.equal((await runOcr(server)).status, 503);
    const restarted = await jobRow(server);
    assert.equal(restarted?.attempt, 1);
    assert.equal(restarted?.dead_lettered_at, null);
    assert.match(restarted?.error_message ?? "", /OCR servisine ulaşılamıyor/);
  });
});

test("yanıt veren ama hata döndüren servis erişilemezlikten ayrılır", async () => {
  // Servis ayaktaysa sebep belgede ya da servisin kendi içinde olabilir;
  // "ulaşılamıyor" demek işletimi yanlış yere bakmaya gönderir.
  const stub = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("motor cokti");
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await withServer(`http://127.0.0.1:${port}`, async (server) => {
      const failed = await runOcr(server);
      assert.notEqual(failed.status, 503);
      assert.doesNotMatch(failed.body.error ?? "", /ulaşılamıyor/);
      // Ayrıntı yine de işe kaydedilir ki işletim sebebi bulabilsin.
      const job = await jobRow(server);
      assert.match(job?.error_message ?? "", /500/);
    });
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("inceleme ekranı başarısız koşudan sonra paneli bayat bırakmaz", async () => {
  // Başarısız koşu da sunucu durumunu değiştirir; yalnız başarıda yenilemek
  // eski deneme sayısını ve eski hatayı ekranda bırakır.
  const source = await (await import("node:fs/promises"))
    .readFile(new URL("../app/archive/document-review.tsx", import.meta.url), "utf8");
  const process = /const process=async\(\)=>\{[\s\S]*?\n  \};/.exec(source)?.[0] ?? "";
  assert.ok(process, "process işlevi okunamadı");
  // Yenileme try/catch'in dışında, yani her iki sonuçta da çalışır.
  assert.match(process, /\}\s*catch\(reason\)\s*\{[\s\S]*?\}\s*\/\*[\s\S]*?\*\/\s*await load\(\)/);
  // Hata yenilemeden SONRA yazılır; `load` başlangıçta hatayı temizler.
  assert.ok(process.indexOf("await load()") < process.indexOf("setError(failureMessage)"),
    "hata mesajı yenilemeden önce yazılıyor; load onu silecektir");
  // Önizleme hatası ayrı durumdadır ve personelin işlemini ezemez.
  assert.match(source, /const \[previewError,setPreviewError\]=useState\(""\)/);
  assert.match(source, /setPreviewError\(reason instanceof Error/);
});
