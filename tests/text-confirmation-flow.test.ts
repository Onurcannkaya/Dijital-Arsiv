/**
 * Metin onaylama akışı — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Onaylanan metin arşivin aranabilir gövdesidir: insanlar bu metinde arar ve
 * bunu alıntılar. Bu yüzden iki şey birlikte doğru olmalıdır — düzeltme arama
 * dizinine geçmeli, ve makinenin okuduğu ile insanın yazdığı birbirinden
 * ayırt edilebilir kalmalıdır.
 *
 * Kapsanan kabuller:
 * - olduğu gibi onay ile düzeltme ayrı olaylar üretir;
 * - düzeltilen metin aranabilir hale gelir, eski metin aramadan düşer;
 * - her sayfa için sürüm zinciri önceki metnin özetine bağlanır;
 * - değişiklik yoksa kayıt yazılmaz;
 * - arşivlenmiş belge metni değiştirilemez;
 * - girdi doğrulaması eksik/çelişkili isteği reddeder.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { normalizeSearch } = await import("../lib/text-search.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const STAFF = "metin@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": STAFF };
const JSON_IDENTITY = { ...IDENTITY, "content-type": "application/json" };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const DOC = "belge-metin";
const PAGE_ONE = "YAPI KULLANMA İZİN BELGESİ Yenişehir Mahallesi 3170 ada 4 parsel B blok.";
const PAGE_TWO = "Yapı sınıfı 3A, toplam 24 bağımsız bölüm.";

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/metin",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    await server.db.prepare(`INSERT INTO archive_documents
        (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
         document_type, unit, status, uploaded_by, created_at, updated_at)
      VALUES (?, 'ARS-2026-MTN', 'yapi.pdf', 'test/mtn', 'application/pdf', 2048, ?,
        'Yapı kullanma izin belgesi', ?, 'review', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
      .bind(DOC, "c".repeat(64), UNIT, STAFF).run();
    for (const [index, text] of [PAGE_ONE, PAGE_TWO].entries()) {
      await server.db.prepare(`INSERT INTO ocr_pages
          (id, document_id, page_number, width, height, raw_text, full_text, search_text,
           words_json, average_confidence, model)
        VALUES (?, ?, ?, 1240, 1754, ?, ?, ?, '[]', 0.8, 'test')`)
        .bind(`${DOC}-p${index + 1}`, DOC, index + 1, text, text, normalizeSearch(text)).run();
    }
    await run(server);
  } finally {
    await server.close();
  }
}

type Body = { error?: string; action?: string; pages?: number };

const patchText = async (server: NodeServer, pages: Array<{ pageNumber: number; text: string }>) => {
  const response = await fetch(`${server.url}/api/documents/${DOC}/text`, {
    method: "PATCH", headers: JSON_IDENTITY, body: JSON.stringify({ pages }),
  });
  return { status: response.status, body: await response.json().catch(() => null) as Body };
};

const search = async (server: NodeServer, query: string) => {
  const response = await fetch(`${server.url}/api/documents?q=${encodeURIComponent(query)}`, { headers: IDENTITY });
  const body = await response.json() as { documents: Array<{ referenceNo: string }> };
  return body.documents.map((entry) => entry.referenceNo);
};

test("olduğu gibi onay ile düzeltme ayrı olaylar üretir", async () => {
  await withServer(async (server) => {
    const confirmed = await patchText(server, [
      { pageNumber: 1, text: PAGE_ONE }, { pageNumber: 2, text: PAGE_TWO },
    ]);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.action, "text.confirmed");

    const corrected = await patchText(server, [{ pageNumber: 2, text: `${PAGE_TWO} Asansör raporu eklidir.` }]);
    assert.equal(corrected.body.action, "text.corrected");

    // Olay, hangi sayfanın değiştiğini sayfa sayfa kaydeder.
    const event = await server.db.prepare(`SELECT details_json FROM audit_events
      WHERE document_id = ? ORDER BY event_number DESC LIMIT 1`).bind(DOC).first<{ details_json: string }>();
    const pages = (JSON.parse(event?.details_json ?? "{}") as {
      pages?: Array<{ pageNumber: number; changed: boolean }> }).pages ?? [];
    assert.deepEqual(pages.map((page) => `${page.pageNumber}:${page.changed}`), ["2:true"]);
  });
});

test("düzeltilen metin aranabilir olur, eski metin aramadan düşer", async () => {
  await withServer(async (server) => {
    /*
     * Metin onayının asıl karşılığı budur: arşivin aranabilir gövdesi
     * personelin doğruladığı metne döner. Dizin güncellenmezse memur
     * düzelttiği kelimeyle belgeyi bulamaz ve düzeltme boşa gider.
     */
    assert.deepEqual(await search(server, "asansor"), []);
    await patchText(server, [{ pageNumber: 2, text: "Asansör tesisat uygunluk belgesi eklidir." }]);
    assert.deepEqual(await search(server, "asansor"), ["ARS-2026-MTN"], "düzeltme dizine geçmedi");

    // Türkçe karakterle de bulunur; dizin ile sorgu aynı normalleştirmeden geçer.
    assert.deepEqual(await search(server, "asansör"), ["ARS-2026-MTN"]);
    // Değiştirilen metnin eski içeriği artık eşleşmemelidir.
    assert.deepEqual(await search(server, "bağımsız"), []);
  });
});

test("her sayfa için sürüm zinciri önceki metnin özetine bağlanır", async () => {
  await withServer(async (server) => {
    await patchText(server, [{ pageNumber: 1, text: PAGE_ONE }]);
    await patchText(server, [{ pageNumber: 1, text: `${PAGE_ONE} Birinci düzeltme.` }]);
    await patchText(server, [{ pageNumber: 1, text: `${PAGE_ONE} İkinci düzeltme.` }]);

    const revisions = await server.db.prepare(`SELECT revision_number, previous_sha256, text_sha256
      FROM text_revisions WHERE document_id = ? AND page_number = 1 ORDER BY revision_number`)
      .bind(DOC).all<{ revision_number: number; previous_sha256: string; text_sha256: string }>();
    const rows = revisions.results ?? [];
    assert.deepEqual(rows.map((row) => row.revision_number), [1, 2, 3]);
    // Her sürüm bir öncekinin özetine bağlanır: ara bir sürüm sessizce
    // değiştirilirse zincir kopar.
    for (let index = 1; index < rows.length; index += 1) {
      assert.equal(rows[index].previous_sha256, rows[index - 1].text_sha256, `sürüm ${index + 1} kopuk`);
    }
  });
});

test("değişiklik yoksa kayıt yazılmaz", async () => {
  await withServer(async (server) => {
    await patchText(server, [{ pageNumber: 1, text: PAGE_ONE }, { pageNumber: 2, text: PAGE_TWO }]);
    const before = await server.db.prepare("SELECT COUNT(*) AS count FROM text_revisions")
      .first<{ count: number }>();

    // Aynı metni yeniden göndermek karar değildir; sürüm ve olay üretmemeli.
    const repeat = await patchText(server, [{ pageNumber: 1, text: PAGE_ONE }, { pageNumber: 2, text: PAGE_TWO }]);
    assert.equal(repeat.status, 409);
    assert.match(repeat.body.error ?? "", /kaydedilecek bir değişiklik bulunmuyor/);

    const after = await server.db.prepare("SELECT COUNT(*) AS count FROM text_revisions")
      .first<{ count: number }>();
    assert.equal(after?.count, before?.count, "no-op sürüm yazdı");
  });
});

test("arşivlenmiş belge metni değiştirilemez", async () => {
  await withServer(async (server) => {
    await patchText(server, [{ pageNumber: 1, text: PAGE_ONE }, { pageNumber: 2, text: PAGE_TWO }]);
    await server.db.prepare("UPDATE archive_documents SET status = 'archived' WHERE id = ?").bind(DOC).run();

    const refused = await patchText(server, [{ pageNumber: 1, text: "arşiv sonrası değişiklik" }]);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error ?? "", /Arşivlenmiş belge metni değiştirilemez/);

    // 409 dönüp yazmış olamaz.
    const page = await server.db.prepare("SELECT confirmed_text FROM ocr_pages WHERE document_id = ? AND page_number = 1")
      .bind(DOC).first<{ confirmed_text: string }>();
    assert.equal(page?.confirmed_text, PAGE_ONE);
  });
});

test("eksik ve çelişkili metin isteği reddedilir", async () => {
  await withServer(async (server) => {
    const rejected: Array<[label: string, pages: unknown]> = [
      ["boş liste", []],
      ["belgede olmayan sayfa", [{ pageNumber: 99, text: "x" }]],
      ["boş metin", [{ pageNumber: 1, text: "   " }]],
      ["geçersiz sayfa numarası", [{ pageNumber: 0, text: "x" }]],
      ["aynı sayfa iki kez", [{ pageNumber: 1, text: "a" }, { pageNumber: 1, text: "b" }]],
    ];
    for (const [label, pages] of rejected) {
      const response = await fetch(`${server.url}/api/documents/${DOC}/text`, {
        method: "PATCH", headers: JSON_IDENTITY, body: JSON.stringify({ pages }),
      });
      assert.equal(response.status, 400, label);
    }
    // Hiçbiri sayfayı onaylamamış olmalı.
    const page = await server.db.prepare("SELECT confirmed_text FROM ocr_pages WHERE document_id = ? AND page_number = 1")
      .bind(DOC).first<{ confirmed_text: string | null }>();
    assert.equal(page?.confirmed_text, null);
  });
});

test("inceleme ekranı personel düzeltmesini olduğu gibi onaydan ayırır", async () => {
  /*
   * Arşivlenen metin insanların arayıp alıntılayacağı metindir. OCR'ın hiç
   * üretmediği bir cümlenin eklendiği sayfa, yalnızca kontrol edilmiş
   * sayfadan maddi olarak farklıdır; ikisi ekranda aynı görünmemeli ve
   * makinenin ne okuduğu erişilebilir kalmalıdır.
   */
  const source = await (await import("node:fs/promises"))
    .readFile(new URL("../app/archive/document-review.tsx", import.meta.url), "utf8");
  assert.match(source, /personel düzeltmesi/);
  assert.match(source, /olduğu gibi onaylandı/);
  assert.match(source, /ocr-original/);
  // Ayrım karşılaştırmayla kurulur, yalnız "onaylandı mı" bilgisiyle değil.
  assert.match(source, /page\.confirmedText!==page\.fullText/);
});
