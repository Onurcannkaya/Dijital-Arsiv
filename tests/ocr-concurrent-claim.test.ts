/**
 * Eşzamanlı OCR iş talebi — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Paralelliğin önkoşulu: makine kapasitesi artsa bile uygulamanın işleri
 * EŞZAMANLI dağıtabilmesi gerekiyor. Ölçüm bu makinede paralelliğin bellekle
 * sınırlı olduğunu gösterdi (işçi başına 4.841 MB), ama daha büyük bir makinede
 * dağıtımın veri açısından güvenli olup olmadığı ayrı bir sorudur ve
 * `OCR_ISLETIM_KURALLARI.md` §5'te ölçülmemiş olarak işaretlenmişti.
 *
 * İş talep etme SQL'i şu biçimdedir:
 *
 *   UPDATE processing_jobs SET status = 'processing' ...
 *   WHERE id = (SELECT ... WHERE status = 'queued' ... LIMIT 1)
 *     AND status IN ('queued', 'failed') RETURNING ...
 *
 * Beklenen davranış: iki eşzamanlı çağrı AYNI işi almaz. SQLite yazmaları
 * sıraya soktuğu için ikinci çağrının alt sorgusu güncellenmiş durumu görür ve
 * sıradaki işi seçer. Bu test o beklentiyi davranışla sabitler; kırılırsa
 * paralel dağıtım iki işçiyi aynı belgeye gönderir.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "eszaman@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": ADMIN };
const UNIT = "İmar ve Şehircilik Müdürlüğü";

/** İstenen belgeyi kaydeden, tek sayfalık sonuç dönen OCR taklidi. */
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
        engine: "fake-ocr", model: "eszaman-1", durationMs: 5,
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

async function seedDocument(server: NodeServer, id: string) {
  await server.db.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
       document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'application/pdf', 2048, ?, 'Encümen karar sureti', ?, 'queued', ?,
      '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
    .bind(id, `ARS-2026-${id.toUpperCase()}`, `${id}.pdf`, `test/${id}`,
      id.padEnd(64, "0"), UNIT, ADMIN).run();
  await server.db.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256, generator)
    VALUES (?, ?, 'original', ?, 'application/pdf', 2048, ?, 'test')`)
    .bind(`obj-${id}`, id, `originals/${id}/1`, id.padEnd(64, "0")).run();
  await server.db.prepare(`INSERT INTO processing_jobs (id, document_id, kind, status, attempt, max_attempts)
    VALUES (?, ?, 'ocr', 'queued', 0, 3)`).bind(`job-${id}`, id).run();
}

test("eşzamanlı iki tetikleme aynı işi iki kez almaz", async () => {
  const ocr = await fakeOcr();
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: `.wrangler/tmp/eszaman-${Math.floor(performance.now() * 1000)}`,
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        OCR_SERVICE_URL: ocr.url,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1", port: 0, scheduler: false,
  });
  try {
    // Dört belge kuyrukta; belge KİMLİĞİ verilmeden tetiklenir, yani her çağrı
    // sıradaki işi kendisi seçer — paralel dağıtımın yapacağı iş budur.
    const ids = ["belge-a", "belge-b", "belge-c", "belge-d"];
    for (const id of ids) await seedDocument(server, id);

    const responses = await Promise.all(ids.map(() =>
      fetch(`${server.url}/api/jobs/process`, { method: "POST", headers: IDENTITY })
        .then(async (response) => ({ status: response.status, body: await response.json() as { processed?: boolean; documentId?: string } }))));

    const islenen = responses.filter((entry) => entry.body.processed).map((entry) => entry.body.documentId);
    // Asıl güvence: aynı belge iki kez işlenmedi.
    assert.equal(new Set(islenen).size, islenen.length,
      `aynı belge birden çok çağrıya verildi: ${islenen.join(", ")}`);
    // Servis de aynı belgeyi iki kez görmedi.
    assert.equal(new Set(ocr.seen).size, ocr.seen.length,
      `OCR servisi aynı belgeyi iki kez aldı: ${ocr.seen.join(", ")}`);

    /*
     * Hiçbir iş kaybolmamalı: dört eşzamanlı çağrı dört işi tüketebilir ama
     * tüketemediği işi KUYRUKTA bırakmalıdır. Kayıp iş, paralel dağıtımın
     * sessizce belge düşürmesi demektir.
     */
    const kalan = await server.db.prepare(`SELECT COUNT(*) AS toplam FROM processing_jobs
      WHERE kind = 'ocr' AND status IN ('queued', 'processing')`).first<{ toplam: number }>();
    const tamamlanan = await server.db.prepare(`SELECT COUNT(*) AS toplam FROM processing_jobs
      WHERE kind = 'ocr' AND status = 'completed'`).first<{ toplam: number }>();
    assert.equal(Number(kalan?.toplam ?? 0) + Number(tamamlanan?.toplam ?? 0), ids.length,
      "iş sayısı korunmadı; eşzamanlı talep iş düşürüyor");
    assert.ok(Number(tamamlanan?.toplam ?? 0) >= 1, "hiçbir iş tamamlanmadı");
  } finally {
    await server.close();
    await ocr.close();
  }
});

test("işi talep eden sorgu durumu atomik olarak değiştirir", async () => {
  /*
   * Kaynak düzeyinde güvence: talep, tek bir koşullu UPDATE ile yapılır.
   * Önce SELECT edip sonra UPDATE eden bir kurgu eşzamanlı çağrıda aynı işi
   * iki kez verirdi; bu testin davranış tarafı onu yakalar, bu tarafı da
   * kurgunun bozulmasını engeller.
   */
  const source = await (await import("node:fs/promises"))
    .readFile(new URL("../app/api/jobs/process/route.ts", import.meta.url), "utf8");
  assert.match(source, /UPDATE processing_jobs\s*\n\s*SET status = 'processing'/);
  assert.match(source, /AND status IN \('queued', 'failed'\)\s*\n\s*RETURNING/);
});
