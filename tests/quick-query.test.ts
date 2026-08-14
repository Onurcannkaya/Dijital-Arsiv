/**
 * Hızlı sorgu dilinin güvenceleri (design.md §3.10).
 *
 * `ada:1284` yalnız ada alanına/ilişkisine bakar; serbest "1284" tam metinde
 * de eşleşir. Bilinmeyen anahtar sessizce yutulmaz, serbest metin olarak
 * aranır. Yalnız süzgeçten oluşan sorgu "aranamaz" sayılmaz.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { parseQuickQuery } = await import("../lib/quick-query.ts");
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const STAFF = "sorgu@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": STAFF };

test("ayrıştırıcı: anahtarlar, Türkçe yazımlar, tırnak ve bilinmeyen anahtar", () => {
  assert.deepEqual(parseQuickQuery("mahalle:Kandemir ada:32 parsel:2"), {
    filters: { mahalle: "Kandemir", ada: "32", parsel: "2" }, freeText: "",
  });
  // Türkçe yazım kanonik anahtara iner; serbest metin korunur.
  assert.deepEqual(parseQuickQuery("tür:Encümen yıl:1996 karar"), {
    filters: { tur: "Encümen", yil: "1996" }, freeText: "karar",
  });
  // Çok kelimeli değer tırnakla; kapanmamış tırnak da sorguyu bozmaz.
  assert.deepEqual(parseQuickQuery('mahalle:"Yeni Mahalle" ref:ARS'), {
    filters: { mahalle: "Yeni Mahalle", ref: "ARS" }, freeText: "",
  });
  // Bilinmeyen anahtar süzgeç değildir; olduğu gibi aranır.
  assert.deepEqual(parseQuickQuery("saat:14 kandemir"), {
    filters: {}, freeText: "saat:14 kandemir",
  });
  // Boş değer süzgeç olmaz; aynı anahtarın son değeri geçerlidir.
  assert.deepEqual(parseQuickQuery("ada: ada:5 ada:7"), {
    filters: { ada: "7" }, freeText: "ada:",
  });
});

async function withSeededServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/sorgu",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1", port: 0, scheduler: false,
  });
  try {
    /*
     * İki belge: aynı serbest metin ("1284") ikisinde de geçer ama ada alanı
     * yalnız birinde 1284'tür — hedefli süzgecin serbest aramadan farkı
     * tam bu ayrımdır.
     */
    const docs = [
      { id: "belge-ada", type: "Encümen karar sureti", unit: "İmar ve Şehircilik Müdürlüğü",
        ada: "1284", date: "11.09.1996", text: "1284 ada 17 parsel encümen kararı" },
      { id: "belge-metin", type: "Numarataj tespit tutanağı", unit: "Yazı İşleri Müdürlüğü",
        ada: "77", date: "05.08.2026", text: "evrak sayısı 1284 olan yazı" },
    ];
    for (const doc of docs) {
      await server.db.prepare(`INSERT INTO archive_documents
          (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
           document_type, unit, status, uploaded_by, created_at, updated_at)
        VALUES (?, ?, 't.pdf', ?, 'application/pdf', 1024, ?, ?, ?, 'review', ?,
          '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
        .bind(doc.id, `ARS-2026-${doc.id.toUpperCase()}`, `k/${doc.id}`, doc.id.padEnd(64, "a"),
          doc.type, doc.unit, STAFF).run();
      for (const [name, value] of [["ada", doc.ada], ["document_date", doc.date]] as const) {
        await server.db.prepare(`INSERT INTO extracted_fields
            (id, document_id, field_name, value_index, field_value, confidence, risk_level,
             page_number, bbox_json, evidence_text, model, verification_status, origin)
          VALUES (?, ?, ?, 0, ?, 0.95, 'LOW', 1, '[]', ?, 'test', 'CONFIRMED', 'OCR')`)
          .bind(`${doc.id}-${name}`, doc.id, name, value, value).run();
      }
      await server.db.prepare(`INSERT INTO ocr_pages
          (id, document_id, page_number, width, height, raw_text, full_text, search_text, words_json, average_confidence, model)
        VALUES (?, ?, 1, 100, 100, ?, ?, ?, '[]', 0.95, 'test')`)
        .bind(`${doc.id}-p1`, doc.id, doc.text, doc.text, doc.text).run();
    }
    await run(server);
  } finally {
    await server.close();
  }
}

const search = async (server: NodeServer, q: string) => {
  const response = await fetch(`${server.url}/api/documents?q=${encodeURIComponent(q)}`, { headers: IDENTITY });
  const body = await response.json() as { documents: Array<{ id: string }>; unsearchableQuery?: boolean;
    quickFilters?: Array<{ key: string; label: string; value: string }> };
  return { ids: body.documents.map((doc) => doc.id).sort(), body };
};

test("hedefli süzgeç serbest aramadan ayrışır ve süzgeçler yanıtla bildirilir", async () => {
  await withSeededServer(async (server) => {
    // Serbest "1284" iki belgeyi de bulur (biri alan, biri tam metin).
    assert.deepEqual((await search(server, "1284")).ids, ["belge-ada", "belge-metin"]);
    // `ada:1284` yalnız ada alanı 1284 olanı bulur; 77'yi ve tam metni değil.
    const targeted = await search(server, "ada:1284");
    assert.deepEqual(targeted.ids, ["belge-ada"]);
    assert.deepEqual(targeted.body.quickFilters, [{ key: "ada", label: "Ada", value: "1284" }]);
    // Ada TAM eşleşir: `ada:128` ne 1284'ü ne 77'yi bulur.
    assert.deepEqual((await search(server, "ada:128")).ids, []);

    // Süzgeç + serbest metin birlikte daraltır.
    assert.deepEqual((await search(server, "tur:Encümen 1284")).ids, ["belge-ada"]);
    assert.deepEqual((await search(server, "mudurluk:Yazı 1284")).ids, ["belge-metin"]);
    assert.deepEqual((await search(server, "yil:1996")).ids, ["belge-ada"]);
    assert.deepEqual((await search(server, "ref:BELGE-METIN")).ids, ["belge-metin"]);

    // Yalnız süzgeçten oluşan sorgu aranabilirdir; "aranamaz" bayrağı yanmaz.
    const filtersOnly = await search(server, "tur:Numarataj");
    assert.equal(filtersOnly.body.unsearchableQuery ?? false, false);
    assert.deepEqual(filtersOnly.ids, ["belge-metin"]);

    // Bilinmeyen anahtar serbest metin olarak aranır; sessizce yutulmaz.
    assert.deepEqual((await search(server, "sayfa:1284")).ids, [],
      "bilinmeyen anahtar metin olarak aranmalı ve 'sayfa:1284' hiçbir belgede geçmemeli");
  });
});
