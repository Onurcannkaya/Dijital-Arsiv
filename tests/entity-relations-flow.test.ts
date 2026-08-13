/**
 * İlişki reddi ve varlık ekleme akışı — gerçek rota, gerçek şema, gerçek SQLite.
 *
 * Ada/parsel ilişkisi belgeye ulaşmanın birincil yoludur; yanlış kurulan
 * ilişki belgeyi başka bir taşınmazın dosyasına sokar. Kararın kendisi kadar
 * KAYDI da önemlidir: denetim zinciri değişmezdir, oraya giren her olay
 * kalıcıdır.
 *
 * Kapsanan kabuller:
 * - varlık kimliğiyle tekildir; aynı parsel ikinci belgede yeni varlık üretmez;
 * - OCR önerisi reddedilebilir ve karar geri alınabilir (arşivlemeden önce);
 * - durumu değiştirmeyen istek denetim zincirine olay YAZMAZ — çift tıklama
 *   olmamış bir insan kararını kalıcılaştırmamalıdır;
 * - girdi doğrulaması eksik/çelişkili isteği reddeder.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const STAFF = "iliski@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": STAFF };
const JSON_IDENTITY = { ...IDENTITY, "content-type": "application/json" };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const PARCEL = { blockNo: "1284", parcelNo: "17", districtCode: "5801", cadastralNeighborhood: "KILAVUZ" };

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/iliski",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    for (const id of ["belge-a", "belge-b"]) {
      await server.db.prepare(`INSERT INTO archive_documents
          (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
           document_type, unit, status, uploaded_by, created_at, updated_at)
        VALUES (?, ?, 'tutanak.pdf', ?, 'application/pdf', 2048, ?, 'Numarataj tespit tutanağı',
          ?, 'review', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
        .bind(id, `ARS-2026-${id.toUpperCase()}`, `test/${id}`, id.padEnd(64, "e"), UNIT, STAFF).run();
    }
    await run(server);
  } finally {
    await server.close();
  }
}

type Body = { error?: string; unchanged?: boolean; saved?: boolean; message?: string;
  entity?: { id: string; displayLabel: string; created: boolean };
  relations?: Array<{ id: string; displayLabel: string; verificationStatus: string }> };

const call = async (server: NodeServer, path: string, method: string, body?: unknown) => {
  const response = await fetch(`${server.url}${path}`, {
    method, headers: body ? JSON_IDENTITY : IDENTITY,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) as Body };
};

const auditActions = async (server: NodeServer, documentId: string) => {
  const rows = await server.db.prepare(`SELECT action FROM audit_events
    WHERE document_id = ? ORDER BY event_number`).bind(documentId).all<{ action: string }>();
  return (rows.results ?? []).map((row) => row.action);
};

/** Toplu senaryo için N adet OCR önerisi eker (SUGGESTED, TEXT_MENTION). */
async function seedSuggestions(server: NodeServer, documentId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const entityId = `varlik-${documentId}-${index}`;
    const relationId = `iliski-${documentId}-${index}`;
    await server.db.prepare(`INSERT INTO entities (id, entity_type, display_label, created_by)
      VALUES (?, 'PARCEL', ?, 'ocr:test')`).bind(entityId, `${100 + index} ada ${index + 1} parsel`).run();
    await server.db.prepare(`INSERT INTO document_entity_relations
        (id, document_id, entity_id, relation_type, relation_source, relation_confidence,
         verification_status, evidence_json, created_by)
      VALUES (?, ?, ?, 'TEXT_MENTION', 'OCR', 0.93, 'SUGGESTED', ?, 'ocr:test')`)
      .bind(relationId, documentId, entityId,
        JSON.stringify({ evidenceText: `${100 + index} ada ${index + 1} parsel`, pageNumber: 1, box: [10, 20 + index, 200, 40 + index] })).run();
    ids.push(relationId);
  }
  return ids;
}

test("toplu karar: 60 ilişki tek istekte, tek denetim olayıyla işlenir", async () => {
  await withServer(async (server) => {
    /*
     * "68 parsel" senaryosunun sunucu yarısı: imar kararı onlarca parsele
     * dokunur ve panel kararları tek PATCH ile gönderir. Sunucu sınırı istek
     * başına 60'tır; panel fazlasını parçalara böler. Buradaki güvence, bir
     * parçanın ATOMİK olduğu ve zincire TEK olay yazdığıdır — 60 karar 60
     * olay olarak yazılsaydı denetim izi okunamaz hale gelirdi; sıfır olay
     * yazılsaydı kararlar kayıtsız kalırdı.
     */
    const ids = await seedSuggestions(server, "belge-a", 60);
    const bulk = await call(server, "/api/documents/belge-a/relations", "PATCH",
      { relations: ids.map((id) => ({ id, action: "verify" })) });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.relations?.filter((item) => item.verificationStatus === "VERIFIED").length, 60);
    assert.deepEqual(await auditActions(server, "belge-a"), ["relation.verified"], "tek olay yazılmalıydı");

    const event = await server.db.prepare(`SELECT details_json FROM audit_events
      WHERE document_id = 'belge-a'`).first<{ details_json: string }>();
    const details = JSON.parse(event?.details_json ?? "{}") as { changes?: unknown[] };
    assert.equal(details.changes?.length, 60, "olay 60 kararın hepsini taşımalı");
  });
});

test("toplu ret ortak gerekçeyle yazılır; 60 üstü tek istek reddedilir", async () => {
  await withServer(async (server) => {
    const ids = await seedSuggestions(server, "belge-a", 61);

    // Sunucu sınırı: 61 ilişki tek istekte işlenmez, istek bütünüyle reddedilir.
    const over = await call(server, "/api/documents/belge-a/relations", "PATCH",
      { relations: ids.map((id) => ({ id, action: "verify" })) });
    assert.equal(over.status, 400);
    assert.deepEqual(await auditActions(server, "belge-a"), [], "reddedilen istek olay yazdı");

    // Panelin ikinci yolu: seçime tek ortak gerekçe (§9.2 kararı).
    const rejected = await call(server, "/api/documents/belge-a/relations", "PATCH", {
      relations: ids.slice(0, 3).map((id) => ({ id, action: "reject", reasonCode: "WRONG_ENTITY", reasonNote: "Kararın kapsamı dışında" })),
    });
    assert.equal(rejected.status, 200);
    const declined = rejected.body.relations?.filter((item) => item.verificationStatus === "REJECTED") ?? [];
    assert.equal(declined.length, 3);
    assert.deepEqual(await auditActions(server, "belge-a"), ["relation.rejected"]);
  });
});

test("varlık kimliğiyle tekildir: aynı parsel ikinci belgede yeniden yaratılmaz", async () => {
  await withServer(async (server) => {
    const first = await call(server, "/api/documents/belge-a/relations", "POST", { parcel: PARCEL });
    assert.equal(first.status, 201);
    assert.equal(first.body.entity?.created, true);

    // Gerçek arşivde bir parselin birden çok belgesi olur; ikincisi mevcut
    // varlığa bağlanmalı, ayrı bir kayıt üretmemelidir.
    const second = await call(server, "/api/documents/belge-b/relations", "POST", { parcel: PARCEL });
    assert.equal(second.status, 201);
    assert.equal(second.body.entity?.created, false);
    assert.equal(second.body.entity?.id, first.body.entity?.id);
  });
});

test("aynı ilişkiyi yeniden göndermek denetim zincirine olay yazmaz", async () => {
  await withServer(async (server) => {
    assert.equal((await call(server, "/api/documents/belge-a/relations", "POST", { parcel: PARCEL })).status, 201);
    assert.deepEqual(await auditActions(server, "belge-a"), ["relation.verified"]);

    /*
     * Çift tıklama ya da zaman aşımı sonrası yeniden gönderim: ne yeni varlık
     * ne yeni ilişki oluşur. Olay yazılırsa denetçi, tek bir ilişki için iki
     * "doğrulandı" okur ve olmamış bir karar kalıcı olarak zincire girer.
     */
    const again = await call(server, "/api/documents/belge-a/relations", "POST", { parcel: PARCEL });
    assert.equal(again.status, 200);
    assert.equal(again.body.unchanged, true);
    assert.equal(again.body.saved, false);
    assert.deepEqual(await auditActions(server, "belge-a"), ["relation.verified"], "no-op olay yazdı");
    assert.equal(again.body.relations?.length, 1, "ilişki mükerrerleşti");
  });
});

test("ilişki reddi kaydedilir, geri alınabilir ve tekrarı olay yazmaz", async () => {
  await withServer(async (server) => {
    const created = await call(server, "/api/documents/belge-a/relations", "POST", { parcel: PARCEL });
    const relationId = created.body.relations?.[0].id ?? "";

    const rejected = await call(server, "/api/documents/belge-a/relations", "PATCH",
      { relations: [{ id: relationId, action: "reject", reasonCode: "WRONG_ENTITY" }] });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.relations?.[0].verificationStatus, "REJECTED");
    assert.deepEqual(await auditActions(server, "belge-a"), ["relation.verified", "relation.rejected"]);

    // Zaten reddedilmiş ilişkiyi yeniden reddetmek karar değildir.
    const twice = await call(server, "/api/documents/belge-a/relations", "PATCH",
      { relations: [{ id: relationId, action: "reject", reasonCode: "WRONG_ENTITY" }] });
    assert.equal(twice.body.unchanged, true);
    assert.deepEqual(await auditActions(server, "belge-a"), ["relation.verified", "relation.rejected"],
      "değişmeyen ret olay yazdı");

    // Arşivlemeden önce karar geri alınabilir; bu gerçek bir karardır ve kaydedilir.
    const restored = await call(server, "/api/documents/belge-a/relations", "PATCH",
      { relations: [{ id: relationId, action: "verify" }] });
    assert.equal(restored.body.relations?.[0].verificationStatus, "VERIFIED");
    assert.deepEqual(await auditActions(server, "belge-a"),
      ["relation.verified", "relation.rejected", "relation.verified"]);
  });
});

test("reddedilmiş ilişkiyi yeniden eklemek kararı kayda geçirir", async () => {
  await withServer(async (server) => {
    const created = await call(server, "/api/documents/belge-a/relations", "POST", { parcel: PARCEL });
    const relationId = created.body.relations?.[0].id ?? "";
    await call(server, "/api/documents/belge-a/relations", "PATCH",
      { relations: [{ id: relationId, action: "reject", reasonCode: "WRONG_ENTITY" }] });

    // Reddedilmiş bir ilişkinin yeniden kurulması durumu DEĞİŞTİRİR; bu
    // no-op değildir ve zincire girmelidir.
    const readded = await call(server, "/api/documents/belge-a/relations", "POST", { parcel: PARCEL });
    assert.equal(readded.status, 201);
    assert.notEqual(readded.body.unchanged, true);
    assert.equal(readded.body.relations?.[0].verificationStatus, "VERIFIED");
    assert.deepEqual(await auditActions(server, "belge-a"),
      ["relation.verified", "relation.rejected", "relation.verified"]);
  });
});

test("eksik ve çelişkili ilişki isteği reddedilir", async () => {
  await withServer(async (server) => {
    const rejected: Array<[label: string, body: unknown]> = [
      ["parsel ve adres birlikte", { parcel: PARCEL, address: { neighborhood: "Esentepe" } }],
      ["ikisi de yok", {}],
      ["sözlük dışı ilişki türü", { parcel: PARCEL, relationType: "OLMAYAN" }],
      ["boş ada/parsel", { parcel: { blockNo: "", parcelNo: "" } }],
    ];
    for (const [label, body] of rejected) {
      const response = await call(server, "/api/documents/belge-a/relations", "POST", body);
      assert.equal(response.status, 400, label);
      assert.ok(response.body.error, `${label} gerekçesiz reddedildi`);
    }
    // Hiçbiri kayıt bırakmamalı.
    assert.deepEqual(await auditActions(server, "belge-a"), []);

    const created = await call(server, "/api/documents/belge-a/relations", "POST", { parcel: PARCEL });
    const relationId = created.body.relations?.[0].id ?? "";
    for (const [label, body] of [
      ["belgede olmayan ilişki", { relations: [{ id: "yok", action: "reject", reasonCode: "MISREAD" }] }],
      ["geçersiz eylem", { relations: [{ id: relationId, action: "sil" }] }],
      ["aynı ilişki iki kez", { relations: [{ id: relationId, action: "reject", reasonCode: "MISREAD" }, { id: relationId, action: "verify" }] }],
      ["boş liste", { relations: [] }],
    ] as Array<[string, unknown]>) {
      const response = await call(server, "/api/documents/belge-a/relations", "PATCH", body);
      assert.equal(response.status, 400, label);
    }
  });
});

test("ret gerekçesi kararın yanında görünür ve geri alınınca temizlenir", async () => {
  await withServer(async (server) => {
    const created = await call(server, "/api/documents/belge-a/relations", "POST", { parcel: PARCEL });
    const relationId = created.body.relations?.[0].id ?? "";

    /*
     * Gerekçe yalnız denetim izine yazılırsa belgeye sonradan bakan kişi
     * göremez ve aynı yanlış parseli yeniden ekleyebilir. "Bu bağ neden
     * koparıldı" sorusu belgeye bakılarak sorulur, ham JSON okunarak değil.
     */
    const rejected = await call(server, "/api/documents/belge-a/relations", "PATCH", {
      relations: [{ id: relationId, action: "reject", reasonCode: "MISREAD", reasonNote: "Tutanakta 1285 yazıyor" }],
    });
    const shown = rejected.body.relations?.[0] as unknown as
      { rejection?: { code: string; label: string; note: string | null } };
    assert.equal(shown.rejection?.code, "MISREAD");
    assert.equal(shown.rejection?.label, "Ada/parsel yanlış okunmuş");
    assert.equal(shown.rejection?.note, "Tutanakta 1285 yazıyor");

    // Belge detayı da taşımalı: inceleme ekranı listeyi oradan okur.
    const detail = await call(server, "/api/documents/belge-a", "GET");
    const fromDetail = (detail.body.relations as unknown as Array<{ rejection?: { code: string } }>)[0];
    assert.equal(fromDetail.rejection?.code, "MISREAD");

    // Karar geri alınınca gerekçe ilişkinin üzerinde asılı kalmamalıdır.
    const restored = await call(server, "/api/documents/belge-a/relations", "PATCH",
      { relations: [{ id: relationId, action: "verify" }] });
    const after = restored.body.relations?.[0] as unknown as { rejection?: unknown; verificationStatus: string };
    assert.equal(after.verificationStatus, "VERIFIED");
    assert.equal(after.rejection, null, "geri alınan ret gerekçesi ilişkide kaldı");
  });
});
