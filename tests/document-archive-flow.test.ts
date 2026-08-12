/**
 * Arşivleme akışı — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Arşivleme belgenin değişmez hale geldiği andır: sistemdeki en sonuçlu
 * geçiş. Yanlış anda arşivlenen kayıt bir daha düzeltilemez, engellenen kayıt
 * ise memuru sebebini bilmeden bekletir. Bu yüzden burada kaynak metni değil
 * davranış ölçülür.
 *
 * Kapsanan kabuller:
 * - her engel ayrı ayrı ve gerekçesiyle döner (ADR-006 doğrulama zorunluluğu);
 * - hazır olmayan durumlar birbirinden ayrılır — bekleyecek olanla harekete
 *   geçmesi gereken memur aynı cümleyi almaz;
 * - arşivleme denetim zincirine kararın dayanağını yazar;
 * - arşivlenmiş belge hiçbir yazma yolundan değiştirilemez (WORM, ADR-016).
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { normalizeSearch } = await import("../lib/text-search.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const STAFF = "arsivci@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": STAFF };
const JSON_IDENTITY = { ...IDENTITY, "content-type": "application/json" };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const DOC = "arsiv-akisi-1";
const TEXT = "NUMARATAJ TESPİT TUTANAĞI Kılavuz Mahallesi 1284 ada 17 parselde bulunan yapıya numarataj verilmiştir.";

/** Numarataj profilinde zorunlu alanlar; sırayla doğrulanacaklar. */
const FIELDS: Array<[name: string, value: string]> = [
  ["document_type", "Numarataj tespit tutanağı"],
  ["unit", UNIT],
  ["document_date", "08.03.2022"],
  ["neighborhood", "Kılavuz"],
  ["ada", "1284"],
  ["parcel", "17"],
];

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/arsiv-akisi",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

/** Terfi etmiş bir belge kurar; kabul hattının tamamı dış servis ister. */
async function seedDocument(server: NodeServer, options: { id?: string; status?: string } = {}) {
  const id = options.id ?? DOC;
  const type = await server.db.prepare("SELECT id, profile_version FROM document_types WHERE code = ?")
    .bind("NUMARATAJ_TUTANAGI").first<{ id: string; profile_version: string }>();
  await server.db.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
       document_type, document_type_id, document_profile_version, unit, status,
       uploaded_by, created_at, updated_at)
    VALUES (?, ?, 'numarataj.pdf', ?, 'application/pdf', 2048, ?, ?, ?, ?, ?, ?, ?,
      '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
    .bind(id, `ARS-2026-${id.toUpperCase()}`, `test/${id}`, "c".repeat(64),
      "Numarataj tespit tutanağı", type?.id ?? null, type?.profile_version ?? null,
      UNIT, options.status ?? "review", STAFF).run();
  await server.db.prepare(`INSERT INTO ocr_pages
      (id, document_id, page_number, width, height, raw_text, full_text, search_text,
       words_json, average_confidence, model)
    VALUES (?, ?, 1, 1240, 1754, ?, ?, ?, '[]', 0.68, 'test')`)
    .bind(`${id}-p1`, id, TEXT, TEXT, normalizeSearch(TEXT)).run();
  for (const [index, [name, value]] of FIELDS.entries()) {
    await server.db.prepare(`INSERT INTO extracted_fields
        (id, document_id, field_name, value_index, field_value, normalized_value, confidence,
         risk_level, page_number, bbox_json, evidence_text, model, verification_status, origin)
      VALUES (?, ?, ?, 0, ?, ?, 0.68, 'MEDIUM', 1, '[]', ?, 'test', 'SUGGESTED', 'OCR')`)
      .bind(`${id}-f${index}`, id, name, value, normalizeSearch(value), value).run();
  }
  return id;
}

const call = async (server: NodeServer, path: string, init?: RequestInit) => {
  const response = await fetch(`${server.url}${path}`, init);
  return { status: response.status, body: await response.json().catch(() => null) as { error?: string } & Record<string, unknown> };
};

const archive = (server: NodeServer, id: string) =>
  call(server, `/api/documents/${id}/approve`, { method: "POST", headers: IDENTITY });

const confirmFields = (server: NodeServer, id: string) =>
  call(server, `/api/documents/${id}/fields`, {
    method: "PATCH", headers: JSON_IDENTITY,
    body: JSON.stringify({ values: FIELDS.map((_, index) => ({ id: `${id}-f${index}`, action: "confirm" })) }),
  });

const confirmText = (server: NodeServer, id: string) =>
  call(server, `/api/documents/${id}/text`, {
    method: "PATCH", headers: JSON_IDENTITY,
    body: JSON.stringify({ pages: [{ pageNumber: 1, text: TEXT }] }),
  });

test("engeller sırayla ve gerekçesiyle bildirilir", async () => {
  await withServer(async (server) => {
    const id = await seedDocument(server);

    // 1. Doğrulama zorunlu alanlar öneri durumundayken arşivlenemez; hangi
    //    alanlar olduğu tek tek adlandırılır, "eksik var" denip bırakılmaz.
    const pendingFields = await archive(server, id);
    assert.equal(pendingFields.status, 409);
    assert.match(pendingFields.body.error ?? "", /Kontrol bekleyen alanlar/);
    for (const label of ["Belge türü", "İlgili müdürlük", "Belge tarihi", "Ada", "Parsel"]) {
      assert.ok(pendingFields.body.error?.includes(label), `${label} adlandırılmadı`);
    }

    // 2. Alanlar onaylanınca sıradaki engel çıkar: onaysız tam metin.
    assert.equal((await confirmFields(server, id)).status, 200);
    const pendingText = await archive(server, id);
    assert.equal(pendingText.status, 409);
    assert.match(pendingText.body.error ?? "", /Tam metin personel tarafından onaylanmadan/);

    // 3. Metin de onaylanınca engel kalmaz.
    assert.equal((await confirmText(server, id)).status, 200);
    assert.equal((await archive(server, id)).status, 200);
  });
});

test("hazır olmayan durumlar birbirinden ayrılır", async () => {
  await withServer(async (server) => {
    // Kuyruktaki ve işlenen belge kendiliğinden ilerler; OCR'ı başarısız olan
    // ilerlemez. Üçüne aynı cümleyi vermek memuru boşuna bekletir.
    const expected: Array<[status: string, pattern: RegExp]> = [
      ["queued", /OCR kuyruğunda/],
      ["processing", /OCR işlemi sürüyor/],
      ["ocr_failed", /başarısız oldu.*yeniden işlenmelidir/],
    ];
    for (const [status, pattern] of expected) {
      const id = await seedDocument(server, { id: `doc-${status}`, status });
      const blocked = await archive(server, id);
      assert.equal(blocked.status, 409, status);
      assert.match(blocked.body.error ?? "", pattern, status);
    }
    // Üç mesaj birbirinden gerçekten farklı olmalı.
    const messages = new Set<string>();
    for (const [status] of expected) {
      messages.add((await archive(server, `doc-${status}`)).body.error ?? "");
    }
    assert.equal(messages.size, 3, "durumlar aynı cümleyi paylaşıyor");
  });
});

test("biçim kuralını çiğneyen değer arşivlenemez", async () => {
  await withServer(async (server) => {
    const id = await seedDocument(server, { id: "doc-bicim" });
    const adaId = `${id}-f4`;
    const correct = (value: string) => call(server, `/api/documents/${id}/fields`, {
      method: "PATCH", headers: JSON_IDENTITY,
      body: JSON.stringify({ values: [{ id: adaId, action: "correct", value }] }),
    });

    // Kayıt sırasında yol kapatılmaz: personel belgede ne yazıyorsa onu
    // girebilmelidir, ama ihlal uyarı olarak bildirilir.
    const written = await correct("abc!!");
    assert.equal(written.status, 200);
    assert.deepEqual((written.body.warnings as Array<{ fieldName: string }>).map((w) => w.fieldName), ["ada"]);

    // Değer geçersizliğini kendi de bilir: risk kritiğe çıkar ve detay yanıtı
    // ihlali bildirir — arayüz kuralın desenini görmediğinden bunu türetemez.
    const detail = await call(server, `/api/documents/${id}`, { headers: IDENTITY });
    const ada = (detail.body.fields as Array<{ name: string; riskLevel: string; formatViolation: string | null }>)
      .find((field) => field.name === "ada");
    assert.equal(ada?.riskLevel, "CRITICAL");
    assert.match(ada?.formatViolation ?? "", /sayı veya `12-A` biçiminde/);

    await call(server, `/api/documents/${id}/fields`, {
      method: "PATCH", headers: JSON_IDENTITY,
      body: JSON.stringify({ values: FIELDS.map((_, index) => ({ id: `${id}-f${index}`, action: "confirm" }))
        .filter((value) => value.id !== adaId) }),
    });
    await confirmText(server, id);

    /*
     * Arşivleme geri alınamaz (ADR-016): buradan sonra hiçbir yazma yolu
     * kaydı düzeltemez. Ada/parsel belediye arşivinde belgeye ulaşmanın
     * birincil yolu olduğundan bozuk bir ada, belgenin parselden bir daha
     * bulunamaması demektir. Uyarının karara bağlanacağı yer burasıdır.
     */
    const blocked = await archive(server, id);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error ?? "", /Biçim kuralına uymayan değerler arşivlenemez/);
    assert.match(blocked.body.error ?? "", /sayı veya `12-A` biçiminde/);

    // Değer düzeltilince engel kalkar ve risk de geri iner.
    assert.equal((await correct("905")).status, 200);
    assert.equal((await archive(server, id)).status, 200);
    const after = await call(server, `/api/documents/${id}`, { headers: IDENTITY });
    const fixed = (after.body.fields as Array<{ name: string; value: string; riskLevel: string }>)
      .find((field) => field.name === "ada");
    assert.equal(fixed?.value, "905");
    assert.notEqual(fixed?.riskLevel, "CRITICAL");
  });
});

test("reddedilen değerin biçimi arşivlemeyi engellemez", async () => {
  await withServer(async (server) => {
    // Reddedilen değer arşive girmez; kuralını çiğnemesi de sonucu bağlamaz.
    // Aksi halde personel, atacağı bir değeri düzeltmeye zorlanırdı.
    const id = await seedDocument(server, { id: "doc-red-bicim" });
    const written = await call(server, `/api/documents/${id}/fields`, {
      method: "PATCH", headers: JSON_IDENTITY,
      body: JSON.stringify({ values: [{ id: `${id}-f4`, action: "correct", value: "abc!!" }] }),
    });
    assert.equal(written.status, 200);
    const rejected = await call(server, `/api/documents/${id}/fields`, {
      method: "PATCH", headers: JSON_IDENTITY,
      body: JSON.stringify({ values: [{ id: `${id}-f4`, action: "reject", reason: "Kanıt okunamıyor" }] }),
    });
    assert.equal(rejected.status, 200);

    // Kalan alanlar ve metin tamamlanır ki engel yalnız reddedilen Ada'dan gelsin.
    await call(server, `/api/documents/${id}/fields`, {
      method: "PATCH", headers: JSON_IDENTITY,
      body: JSON.stringify({ values: FIELDS.map((_, index) => ({ id: `${id}-f${index}`, action: "confirm" }))
        .filter((value) => value.id !== `${id}-f4`) }),
    });
    await confirmText(server, id);

    const blocked = await archive(server, id);
    assert.equal(blocked.status, 409);
    // Engel biçimden değil, zorunlu alanın değersiz kalmasından gelmelidir.
    assert.doesNotMatch(blocked.body.error ?? "", /Biçim kuralına uymayan/);
    assert.match(blocked.body.error ?? "", /doğrulanmış bir değer olmadan arşivlenemez/);
  });
});

test("reddedilen zorunlu alan arşivlemeyi durdurur", async () => {
  await withServer(async (server) => {
    const id = await seedDocument(server, { id: "doc-reddedilen" });
    // Ada reddedilir, kalanlar onaylanır: profilde zorunlu bir alan
    // kullanılabilir değer olmadan kalır.
    const mixed = await call(server, `/api/documents/${id}/fields`, {
      method: "PATCH", headers: JSON_IDENTITY,
      body: JSON.stringify({
        values: FIELDS.map(([name], index) => ({
          id: `${id}-f${index}`,
          action: name === "ada" ? "reject" : "confirm",
          reason: name === "ada" ? "Kanıt okunamıyor" : undefined,
        })),
      }),
    });
    assert.equal(mixed.status, 200);
    assert.equal((await confirmText(server, id)).status, 200);

    const blocked = await archive(server, id);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error ?? "", /doğrulanmış bir değer olmadan arşivlenemez/);
    assert.match(blocked.body.error ?? "", /Ada/);
  });
});

test("arşivleme kararın dayanağını denetim zincirine yazar", async () => {
  await withServer(async (server) => {
    const id = await seedDocument(server, { id: "doc-denetim" });
    await confirmFields(server, id);
    await confirmText(server, id);
    const archived = await archive(server, id);
    assert.equal(archived.status, 200);
    assert.equal(archived.body.archived, true);

    const detail = await call(server, `/api/documents/${id}`, { headers: IDENTITY });
    assert.equal((detail.body.document as { status: string }).status, "archived");

    type Event = { eventNumber: number; action: string; previousHash: string | null; eventHash: string;
      details: Record<string, unknown> };
    const chain = (detail.body.audit as Event[]).slice().sort((a, b) => a.eventNumber - b.eventNumber);
    // Zincir kopuksuz: her olay bir öncekinin özetine bağlanır (ADR-016).
    assert.equal(chain[0].previousHash, null);
    for (let index = 1; index < chain.length; index += 1) {
      assert.equal(chain[index].previousHash, chain[index - 1].eventHash, `#${chain[index].eventNumber} kopuk`);
    }
    const event = chain.find((entry) => entry.action === "document.archived");
    assert.ok(event, "arşivleme olayı yazılmadı");
    // Karar sonradan denetlenebilmeli: hangi profil sürümü, hangi zorunlu
    // alanlar ve hangi asıl dosya üzerinden verildiği kayıtta durmalıdır.
    assert.equal(event.details.toStatus, "archived");
    assert.equal(event.details.profileCode, "NUMARATAJ_TUTANAGI");
    assert.equal(event.details.confirmedTextPages, 1);
    assert.equal(event.details.sourceSha256, "c".repeat(64));
    assert.deepEqual(event.details.requiredFields, FIELDS.map(([name]) => name));
  });
});

test("arşivlenmiş belge hiçbir yazma yolundan değiştirilemez", async () => {
  await withServer(async (server) => {
    const id = await seedDocument(server, { id: "doc-kilit" });
    await confirmFields(server, id);
    await confirmText(server, id);
    assert.equal((await archive(server, id)).status, 200);

    // Aynı belge iki kez arşivlenemez; ikinci istek sessizce başarılı olmaz.
    const again = await archive(server, id);
    assert.equal(again.status, 409);
    assert.match(again.body.error ?? "", /daha önce arşivlenmiş/);

    // WORM: değer düzeltme, değer ekleme, metin ve ilişki yazımı kapalıdır.
    const writes: Array<[label: string, path: string, method: string, body: unknown]> = [
      ["alan düzeltme", `/api/documents/${id}/fields`, "PATCH",
        { values: [{ id: `${id}-f0`, action: "correct", value: "Değiştirildi" }] }],
      ["alan ekleme", `/api/documents/${id}/fields`, "PATCH",
        { additions: [{ fieldName: "addressee", value: "Sonradan Eklenen" }] }],
      ["metin yazma", `/api/documents/${id}/text`, "PATCH",
        { pages: [{ pageNumber: 1, text: "sonradan değiştirilen metin" }] }],
      ["ilişki ekleme", `/api/documents/${id}/relations`, "POST",
        { entityKind: "PARCEL", neighborhood: "Kılavuz", ada: "999", parcel: "1" }],
    ];
    for (const [label, path, method, body] of writes) {
      const rejected = await call(server, path, { method, headers: JSON_IDENTITY, body: JSON.stringify(body) });
      assert.equal(rejected.status, 409, `${label} engellenmedi`);
      assert.match(rejected.body.error ?? "", /Arşivlenmiş belge/, label);
    }

    // Alan değerleri gerçekten korunmuş olmalı: 409 dönüp yazmış olamaz.
    const detail = await call(server, `/api/documents/${id}`, { headers: IDENTITY });
    const values = (detail.body.fields as Array<{ name: string; value: string }>);
    assert.equal(values.find((field) => field.name === "document_type")?.value, "Numarataj tespit tutanağı");
    assert.ok(!values.some((field) => field.name === "addressee"), "arşiv sonrası alan eklenmiş");
  });
});

test("bulunmayan belge ve yetkisiz istek ayrı ayrı reddedilir", async () => {
  await withServer(async (server) => {
    const missing = await archive(server, "olmayan-belge");
    assert.equal(missing.status, 404);
    assert.match(missing.body.error ?? "", /Belge bulunamadı/);
    // Kimliksiz istek arşivleme uçuna hiç ulaşmaz.
    const anonymous = await fetch(`${server.url}/api/documents/${DOC}/approve`, { method: "POST" });
    assert.equal(anonymous.status, 401);
  });
});
