/**
 * OCR sayfa dilimi akışı — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Ölçüm (D:\Arşiv gerçek taramaları, Windows CPU, ısınmış süreç): sayfa başına
 * ~65 sn. Belgenin tamamını tek istekte işlemek 623 sayfalık bir dosyada 11
 * saat sürer; eski 120 sn tavanı 1,8 sayfaya karşılık geliyordu ve iş HER
 * denemede baştan başlayıp hiç ilerlemiyordu. Üstelik zaman aşımı servisi
 * durdurmadığı için terk edilen çıkarım tek uçuşlu kilidi saatlerce tutuyor,
 * kuyruktaki bütün belgeler bekliyordu.
 *
 * Bu testler düzeltmenin davranışını sabitler:
 * - iş dilim dilim ilerler, ilerleme işte taşınır ve belge yarıda "incelemeye"
 *   açılmaz;
 * - ilerleyen dilim deneme bütçesini tüketmez;
 * - devam eden dilim önceki sayfaların sonucunu silmez;
 * - dilimler arası tekrar eden değerler bir kez yazılır;
 * - tek değerli alan ancak belgenin tamamı okunduktan sonra kapanır;
 * - kalan sayfaları bildirmeyen yanıt sessizce "tamamlandı" sayılmaz.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "dilim@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": ADMIN };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const DOC = "dilimli-belge";

type WindowRequest = { pageFrom: number };
type FakeOptions = {
  /** Belgenin toplam sayfa sayısı. */
  pageCount: number;
  /** Servisin bir istekte işlediği sayfa sayısı. */
  windowSize: number;
  /** Sayfa numarasına göre alan adayları üretir. */
  fieldsFor?: (pageNumber: number) => Array<Record<string, unknown>>;
  /** Sözleşmeyi bilerek bozan yanıt üretmek için. */
  corrupt?: (payload: Record<string, unknown>) => Record<string, unknown>;
};

/** Sayfa dilimi sözleşmesine uyan OCR taklidi; istenen aralığı döndürür. */
function fakeWindowedOcr(options: FakeOptions) {
  const seen: WindowRequest[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { pageFrom?: number };
      const pageFrom = Number(parsed.pageFrom ?? 1);
      seen.push({ pageFrom });
      const pageTo = Math.min(pageFrom + options.windowSize - 1, options.pageCount);
      const pages = [];
      const fields = [];
      for (let number = pageFrom; number <= pageTo; number += 1) {
        pages.push({
          pageNumber: number, width: 100, height: 140,
          rawText: `SAYFA ${number}`, fullText: `SAYFA ${number}`,
          averageConfidence: 0.9, words: [],
        });
        fields.push(...(options.fieldsFor?.(number) ?? []));
      }
      const payload: Record<string, unknown> = {
        engine: "fake-ocr", model: "dilim-1", durationMs: 5,
        pageCount: options.pageCount, pageFrom, pageTo,
        nextPage: pageTo < options.pageCount ? pageTo + 1 : null,
        accessDerivative: null, pages, fields,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(options.corrupt ? options.corrupt(payload) : payload));
    });
  });
  return new Promise<{ url: string; seen: WindowRequest[]; close: () => Promise<void> }>((resolve) => {
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

async function withServer(ocrServiceUrl: string, run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: `.wrangler/tmp/dilim-${Math.floor(performance.now() * 1000)}`,
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        OCR_SERVICE_URL: ocrServiceUrl,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1", port: 0, scheduler: false,
  });
  try {
    await server.db.prepare(`INSERT INTO archive_documents
        (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
         document_type, unit, status, uploaded_by, created_at, updated_at)
      VALUES (?, 'ARS-2026-DILIM', 'toplu-tarama.pdf', 'test/dilim', 'application/pdf', 4096, ?,
        'Encümen karar sureti', ?, 'queued', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
      .bind(DOC, "e".repeat(64), UNIT, ADMIN).run();
    await server.db.prepare(`INSERT INTO binary_objects
        (id, document_id, object_class, object_key, media_type, byte_size, sha256, generator)
      VALUES ('obj-dilim', ?, 'original', 'originals/dilim/1', 'application/pdf', 4096, ?, 'test')`)
      .bind(DOC, "e".repeat(64)).run();
    await server.db.prepare(`INSERT INTO processing_jobs (id, document_id, kind, status, attempt, max_attempts)
      VALUES ('job-dilim', ?, 'ocr', 'queued', 0, 3)`).bind(DOC).run();
    await run(server);
  } finally {
    await server.close();
  }
}

type ProcessResult = {
  processed?: boolean; completed?: boolean; pageFrom?: number; pageTo?: number;
  pageCount?: number; nextPage?: number | null; pages?: number; error?: string;
};

const runOcr = async (server: NodeServer): Promise<{ status: number; body: ProcessResult }> => {
  const response = await fetch(`${server.url}/api/jobs/process?documentId=${DOC}`,
    { method: "POST", headers: IDENTITY });
  return { status: response.status, body: await response.json().catch(() => ({})) as ProcessResult };
};

const jobRow = (server: NodeServer) => server.db
  .prepare(`SELECT status, attempt, next_page, page_count, error_message
    FROM processing_jobs WHERE id = 'job-dilim'`)
  .first<{ status: string; attempt: number; next_page: number; page_count: number | null; error_message: string | null }>();

const documentStatus = async (server: NodeServer) => (await server.db
  .prepare("SELECT status FROM archive_documents WHERE id = ?").bind(DOC)
  .first<{ status: string }>())?.status;

const pageNumbers = async (server: NodeServer) => (await server.db
  .prepare("SELECT page_number FROM ocr_pages WHERE document_id = ? ORDER BY page_number").bind(DOC)
  .all<{ page_number: number }>()).results.map((row) => row.page_number);

test("çok sayfalı belge dilim dilim işlenir ve yarıda incelemeye açılmaz", async () => {
  const ocr = await fakeWindowedOcr({ pageCount: 5, windowSize: 2 });
  try {
    await withServer(ocr.url, async (server) => {
      const first = await runOcr(server);
      assert.equal(first.status, 200);
      assert.equal(first.body.processed, true);
      // İş TAMAMLANMADI: belge henüz bitmedi.
      assert.equal(first.body.completed, false);
      assert.deepEqual([first.body.pageFrom, first.body.pageTo, first.body.nextPage], [1, 2, 3]);
      assert.equal(first.body.pageCount, 5);

      const afterFirst = await jobRow(server);
      assert.equal(afterFirst?.status, "queued", "iş kuyruğa dönmedi; kalan sayfalar hiç işlenmez");
      assert.equal(afterFirst?.next_page, 3, "ilerleme kaydedilmedi; iş baştan başlar");
      assert.equal(afterFirst?.page_count, 5);
      /*
       * Belge yarıda "review" olursa memur eksik metinli bir belgeyi doğrulamaya
       * başlar ve kalan sayfalar hiç okunmamış olarak arşive girer.
       */
      assert.equal(await documentStatus(server), "queued");
      assert.deepEqual(await pageNumbers(server), [1, 2]);

      const second = await runOcr(server);
      assert.equal(second.body.completed, false);
      assert.deepEqual([second.body.pageFrom, second.body.pageTo, second.body.nextPage], [3, 4, 5]);
      // Devam eden dilim öncekini silmez.
      assert.deepEqual(await pageNumbers(server), [1, 2, 3, 4]);

      const third = await runOcr(server);
      assert.equal(third.body.completed, true, "son dilim belgeyi kapatmadı");
      assert.equal(third.body.pages, 5, "tamamlanma raporu belgenin tamamını saymadı");
      assert.deepEqual(await pageNumbers(server), [1, 2, 3, 4, 5]);
      assert.equal(await documentStatus(server), "review");

      const closed = await jobRow(server);
      assert.equal(closed?.status, "completed");
      assert.equal(closed?.error_message, null);

      // Servis gerçekten kaldığı yerden istendi.
      assert.deepEqual(ocr.seen.map((entry) => entry.pageFrom), [1, 3, 5]);
    });
  } finally {
    await ocr.close();
  }
});

test("ilerleyen dilim deneme bütçesini tüketmez", async () => {
  /*
   * Sayaç dilim başına artarsa 200 sayfalık bir belge üçüncü dilimde
   * dead-letter'a düşer. Azami deneme bütçesi ARIZA için ayrılmıştır;
   * ilerleyen bir dilim servisin sağlıklı olduğunun kanıtıdır.
   */
  const ocr = await fakeWindowedOcr({ pageCount: 9, windowSize: 1 });
  try {
    await withServer(ocr.url, async (server) => {
      for (let round = 0; round < 5; round += 1) {
        const result = await runOcr(server);
        assert.equal(result.body.processed, true, `${round + 1}. dilim işlenemedi`);
        const job = await jobRow(server);
        assert.equal(job?.attempt, 0, "ilerleyen dilim deneme sayacını tüketti");
        assert.notEqual(job?.status, "failed");
      }
      assert.equal((await jobRow(server))?.next_page, 6);
    });
  } finally {
    await ocr.close();
  }
});

test("dilimler arası tekrar eden değer bir kez yazılır", async () => {
  // Müdürlük her sayfada tekrar eder; 1.749 sayfalık bir belgede aynı değer
  // yüzlerce satır olarak birikirse inceleme ekranı kullanılamaz hâle gelir.
  const ocr = await fakeWindowedOcr({
    pageCount: 4, windowSize: 1,
    fieldsFor: (pageNumber) => [{
      name: "unit", value: UNIT, normalizedValue: UNIT, confidence: 0.95,
      pageNumber, box: [0, 0, 10, 10], evidenceText: `${UNIT} sayfa ${pageNumber}`,
    }],
  });
  try {
    await withServer(ocr.url, async (server) => {
      for (let round = 0; round < 4; round += 1) await runOcr(server);
      const rows = await server.db.prepare(`SELECT field_value, value_index FROM extracted_fields
        WHERE document_id = ? AND field_name = 'unit' AND origin = 'OCR'`).bind(DOC)
        .all<{ field_value: string; value_index: number }>();
      assert.equal(rows.results.length, 1, "aynı değer her dilimde yeniden yazıldı");
      assert.equal(rows.results[0].value_index, 0);
    });
  } finally {
    await ocr.close();
  }
});

test("tek değerli alan belgenin tamamı okunduktan sonra en güvenli adayla kapanır", async () => {
  /*
   * Kazananı dilim başına seçmek her dilimden bir kazanan bırakır; belge
   * tarihi gibi tek değerli bir alan böylece birden çok değer taşır. İndirgeme
   * ancak bütün sayfalar okunduktan sonra yapılabilir.
   */
  const dates = new Map([[1, { value: "01.01.2021", confidence: 0.55 }],
    [2, { value: "02.02.2021", confidence: 0.99 }],
    [3, { value: "03.03.2021", confidence: 0.71 }]]);
  const ocr = await fakeWindowedOcr({
    pageCount: 3, windowSize: 1,
    fieldsFor: (pageNumber) => {
      const entry = dates.get(pageNumber);
      return entry ? [{
        name: "document_date", value: entry.value, normalizedValue: entry.value,
        confidence: entry.confidence, pageNumber, box: [0, 0, 10, 10],
        evidenceText: `tarih ${entry.value}`,
      }] : [];
    },
  });
  try {
    await withServer(ocr.url, async (server) => {
      const first = await runOcr(server);
      assert.equal(first.body.completed, false);
      // Ara dilimlerde bütün adaylar durur: kazanan henüz bilinemez.
      const midway = await server.db.prepare(`SELECT COUNT(*) AS total FROM extracted_fields
        WHERE document_id = ? AND field_name = 'document_date'`).bind(DOC).first<{ total: number }>();
      assert.equal(midway?.total, 1);

      await runOcr(server);
      const last = await runOcr(server);
      assert.equal(last.body.completed, true);

      const rows = await server.db.prepare(`SELECT field_value, confidence, value_index
        FROM extracted_fields WHERE document_id = ? AND field_name = 'document_date'`).bind(DOC)
        .all<{ field_value: string; confidence: number; value_index: number }>();
      assert.equal(rows.results.length, 1, "tek değerli alan indirgenmedi");
      assert.equal(rows.results[0].field_value, "02.02.2021", "en güvenli aday seçilmedi");
      assert.equal(rows.results[0].value_index, 0);
    });
  } finally {
    await ocr.close();
  }
});

test("servis hâlâ çalışıyorsa deneme bütçesi harcanmaz", async () => {
  /*
   * Zaman aşımına düşen istek servisi durdurmaz; yeniden deneme süren koşuya
   * denk gelir ve servis 409 döner. Bu arıza sayılırsa belge, servis sağlıklı
   * olduğu hâlde üç denemede dead-letter'a düşer.
   */
  const busy = createServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "Bu belge için OCR çıkarımı hâlihazırda sürüyor" }));
  });
  await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
  const address = busy.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await withServer(`http://127.0.0.1:${port}`, async (server) => {
      await server.db.prepare("UPDATE processing_jobs SET next_page = 7 WHERE id = 'job-dilim'").run();
      const result = await runOcr(server);
      assert.equal(result.status, 200);
      // Başarı diye bildirilmez: hiçbir sayfa işlenmedi.
      assert.equal(result.body.processed, false);

      const job = await jobRow(server);
      assert.equal(job?.status, "queued");
      assert.equal(job?.attempt, 0, "süren koşu deneme bütçesini tüketti");
      assert.equal(job?.next_page, 7, "ilerleme kaybedildi; belge baştan başlar");
      assert.match(job?.error_message ?? "", /hâlâ işliyor/);
      assert.notEqual(await documentStatus(server), "review");
    });
  } finally {
    await new Promise<void>((resolve) => busy.close(() => resolve()));
  }
});

test("kalan sayfaları bildirmeyen yanıt tamamlandı sayılmaz", async () => {
  /*
   * `nextPage` düşen bir yanıt, 1.749 sayfalık bir belgeyi ilk dilimden sonra
   * "tamamlandı" saydırır ve okunmamış sayfalar sessizce kaybolur. Sözleşme
   * bunu hata olarak bildirmek zorundadır.
   */
  const ocr = await fakeWindowedOcr({
    pageCount: 5, windowSize: 2,
    corrupt: (payload) => ({ ...payload, nextPage: null }),
  });
  try {
    await withServer(ocr.url, async (server) => {
      const result = await runOcr(server);
      assert.notEqual(result.status, 200, "eksik dilim sessizce kabul edildi");
      // Belge incelemeye AÇILMAZ: eksik metinle doğrulama yapılamaz.
      assert.notEqual(await documentStatus(server), "review");
      const job = await jobRow(server);
      assert.notEqual(job?.status, "completed");
      // Sebep işin kaydında durur ki işletim nereye bakacağını bilsin.
      assert.match(job?.error_message ?? "", /kalan sayfa/i);
      // Yazma toplu yapılır: reddedilen yanıttan hiçbir sayfa sızmaz.
      assert.equal((await pageNumbers(server)).length, 0);
    });
  } finally {
    await ocr.close();
  }
});
