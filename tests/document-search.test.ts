/**
 * Belge arama ve süzme davranışı — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Arama, memurun arşive tek giriş kapısıdır: yanlış sonuç kümesi yanlış
 * belgeyle işlem yapılmasına yol açar. Bu yüzden burada kaynak metni değil
 * davranış ölçülür.
 *
 * Kapsanan kabuller:
 * - Türkçe/ASCII ayrımı aramayı bozmaz (`kilavuz` → `Kılavuz`);
 * - dizin ile sorgu aynı normalleştirmeden geçer (`normalizeSearch`);
 * - çok terimli sorgu VE anlamındadır;
 * - yalnız noktalama içeren sorgu süzgeci DÜŞÜRMEZ, boş sonuç döner;
 * - LIKE joker karakterleri kaçırılır, durum/limit/imleç girdisi doğrulanır;
 * - anahtar kümesi sayfalaması mükerrer ya da eksik kayıt üretmez.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { normalizeSearch } = await import("../lib/text-search.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const STAFF = "arama@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": STAFF };

type Seed = { ref: string; name: string; type: string; unit: string; status: string; text: string };

const SEEDS: Seed[] = [
  {
    ref: "ARS-2026-KILAVUZ", name: "encumen-karari-2019.pdf", type: "Encümen karar sureti",
    unit: "Emlak ve İstimlak Müdürlüğü", status: "archived",
    text: "ENCÜMEN KARARI Kılavuz Mahallesi 1284 ada 17 parsel yol katılım payı oybirliğiyle kabul edilmiştir.",
  },
  {
    ref: "ARS-2026-LOKANTA", name: "isyeri-acma-ruhsati-2023.pdf", type: "İşyeri açma ruhsatı",
    unit: "Ruhsat ve Denetim Müdürlüğü", status: "review",
    text: "İŞYERİ AÇMA VE ÇALIŞMA RUHSATI Esentepe Mahallesi 905 ada 62 parselde lokanta faaliyeti için verilmiştir.",
  },
  {
    ref: "ARS-2026-YAPI", name: "yapi-kullanma-izni-2021.pdf", type: "Yapı kullanma izin belgesi",
    unit: "İmar ve Şehircilik Müdürlüğü", status: "archived",
    text: "YAPI KULLANMA İZİN BELGESİ Yenişehir Mahallesi 3170 ada 4 parsel B blok yapı sınıfı 3A.",
  },
];

async function withArchive(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      // Depolama sürücüsü aramada kullanılmaz; yerel disk sürücüsü yeterlidir.
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/arama-testi",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    // Kabul hattının tamamı (tarama, terfi, OCR) dış servis ister; arama
    // davranışı için terfi ETMİŞ kayıt doğrudan kurulur.
    for (const [index, seed] of SEEDS.entries()) {
      const id = `doc-${index}`;
      const createdAt = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
      await server.db.prepare(`INSERT INTO archive_documents
          (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
           document_type, unit, status, uploaded_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'application/pdf', 1024, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, seed.ref, seed.name, `test/${id}`, String(index).padEnd(64, "a"),
          seed.type, seed.unit, seed.status, STAFF, createdAt, createdAt).run();
      // Dizin, sorgunun kullandığı fonksiyonla üretilir (lib/text-search.ts).
      await server.db.prepare(`INSERT INTO ocr_pages
          (id, document_id, page_number, width, height, raw_text, full_text, search_text,
           words_json, average_confidence, model)
        VALUES (?, ?, 1, 1240, 1754, ?, ?, ?, '[]', 0.9, 'test')`)
        .bind(`page-${index}`, id, seed.text, seed.text, normalizeSearch(seed.text)).run();
    }
    await run(server);
  } finally {
    await server.close();
  }
}

type Listed = { documents: Array<{ referenceNo: string; contentMatch: boolean }>;
  unsearchableQuery?: boolean; page: { nextCursor: string | null; hasMore: boolean } };

async function list(server: NodeServer, query: string) {
  const response = await fetch(`${server.url}/api/documents?${query}`, { headers: IDENTITY });
  const body = await response.json() as Listed & { error?: string };
  return { status: response.status, body, refs: (body.documents ?? []).map((d) => d.referenceNo) };
}

test("Türkçe karakter aramayı bölmez: ASCII yazan memur da belgeyi bulur", async () => {
  await withArchive(async (server) => {
    // Memurların çoğu Türkçe klavye kullanmaz; `kilavuz` yazan da bulmalıdır.
    for (const term of ["Kılavuz", "kılavuz", "kilavuz", "KILAVUZ", "KiLAVUZ"]) {
      const found = await list(server, `q=${encodeURIComponent(term)}`);
      assert.deepEqual(found.refs, ["ARS-2026-KILAVUZ"], `"${term}" eşleşmedi`);
      assert.equal(found.body.documents[0].contentMatch, true, `"${term}" tam metin bayrağı yok`);
    }
    // Ayrı yönde: Türkçe yazan da ASCII dizini bulur.
    assert.deepEqual((await list(server, "q=oybirli%C4%9Fiyle")).refs, ["ARS-2026-KILAVUZ"]);
  });
});

test("çok terimli sorgu VE anlamındadır", async () => {
  await withArchive(async (server) => {
    assert.deepEqual((await list(server, "q=kilavuz+katilim")).refs, ["ARS-2026-KILAVUZ"]);
    // İkinci terim hiçbir belgede yoksa sonuç boştur; VEYA'ya düşmez.
    assert.deepEqual((await list(server, "q=kilavuz+zzzzzz")).refs, []);
    assert.deepEqual((await list(server, "q=lokanta+1284")).refs, []);
  });
});

test("yalnız noktalama içeren sorgu süzgeci düşürmez", async () => {
  await withArchive(async (server) => {
    // Normalleştirmede boşalan sorguda süzgeç eklenmezse liste SÜZÜLMEMİŞ
    // döner ve arayüz bunu "sonuç" diye sunar: memur aradığını bulduğunu sanır.
    for (const term of ["......", "%%", "--", "///"]) {
      const found = await list(server, `q=${encodeURIComponent(term)}`);
      assert.equal(found.status, 200, `"${term}" istisna üretti`);
      assert.deepEqual(found.refs, [], `"${term}" süzülmemiş liste döndürdü`);
      assert.equal(found.body.unsearchableQuery, true, `"${term}" sebebi bildirmedi`);
      assert.equal(found.body.page.hasMore, false);
    }
    // Terimsiz istek bambaşkadır: tüm liste döner ve sebep bildirilmez.
    const all = await list(server, "");
    assert.equal(all.refs.length, SEEDS.length);
    assert.equal(all.body.unsearchableQuery, undefined);
  });
});

test("joker karakter içeren sorgu sonuç kümesini genişletmez", async () => {
  await withArchive(async (server) => {
    // Karakter düzeyinde kaçış `escapeLike` testlerindedir; burada ölçülen,
    // uçtan uca sonucun genişlememesidir: `%` joker gibi işleseydi tek terim
    // bütün arşivi getirirdi.
    assert.deepEqual((await list(server, "q=%25lokanta%25")).refs, ["ARS-2026-LOKANTA"]);
    assert.deepEqual((await list(server, "q=lokanta%25yapi")).refs, []);
  });
});

test("durum, limit ve imleç girdisi doğrulanır", async () => {
  await withArchive(async (server) => {
    assert.deepEqual((await list(server, "status=archived")).refs,
      ["ARS-2026-YAPI", "ARS-2026-KILAVUZ"]);
    assert.deepEqual((await list(server, "status=review")).refs, ["ARS-2026-LOKANTA"]);
    // Süzme sunucuda yapılır; bilinmeyen durum sessizce yok sayılmaz.
    for (const bad of ["status=arsivlendi", "status=archived,DROP", "limit=0", "limit=201",
      "limit=abc", "limit=1.5", "cursor=bozuk!!"]) {
      const rejected = await list(server, bad);
      assert.equal(rejected.status, 400, `"${bad}" kabul edildi`);
      assert.ok(rejected.body.error, `"${bad}" gerekçesiz reddedildi`);
    }
  });
});

test("anahtar kümesi sayfalaması mükerrer ya da eksik kayıt üretmez", async () => {
  await withArchive(async (server) => {
    const expected = (await list(server, "")).refs;
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof list>> = await list(server,
        `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      walked.push(...page.refs);
      cursor = page.body.page.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(walked, expected, "sayfalanmış sıra tek seferdekinden farklı");
    assert.equal(new Set(walked).size, walked.length, "mükerrer kayıt");
  });
});
