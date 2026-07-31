import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVE_SCHEMA_VERSION, SCHEMA_MANIFEST, applyArchiveMigrations,
  assertSchemaReady, declaredColumns, readMaintenanceProgress, readSchemaVersion,
  requireArchiveSchema, runMaintenanceSlice, SchemaNotReadyError,
} from "../lib/archive-schema.ts";
import { isPendingDerivative, resolveOriginalObject, resolveViewableObject } from "../lib/binary-objects.ts";
import { columnsOf, createSqliteD1, indexesOf, rejects, tablesOf } from "./sqlite-d1.ts";

/**
 * Şema ve göç davranış testleri.
 *
 * Bu testler DDL'i gerçekten çalıştırır: taze kurulum, sürüm 1'den yükseltme,
 * kısıtların uygulanması ve tohum verisi. Dize araması yapan bir test, bir
 * kolonun `CREATE TABLE`'a eklenip göç adımına eklenmediğini göremez.
 */

test("kolon bildirimi ayrıştırıcısı kısıt satırlarını kolon saymaz", () => {
  const parsed = declaredColumns(`CREATE TABLE IF NOT EXISTS ornek (
    id TEXT PRIMARY KEY NOT NULL,
    -- açıklama satırı
    sayi INTEGER NOT NULL DEFAULT 0,
    baska TEXT REFERENCES digeri(id) ON DELETE CASCADE,
    CHECK (sayi >= 0),
    CHECK (id IN ('a', 'b')),
    UNIQUE (id, sayi)
  )`);
  assert.deepEqual(parsed, ["id", "sayi", "baska"]);
});

test("beklenen kolon listesi DDL'den türetilir, elle tutulmaz", () => {
  // Elle tutulan bir liste, DDL'e eklenen kolonu sessizce atlar.
  assert.ok(Object.keys(SCHEMA_MANIFEST).length >= 15, "manifest tablo sayısı beklenenden az");
  assert.ok(SCHEMA_MANIFEST.extracted_fields.includes("verified_by"));
  assert.ok(SCHEMA_MANIFEST.extracted_fields.includes("field_definition_id"));
  assert.ok(SCHEMA_MANIFEST.archive_documents.includes("document_type_id"));
  // Kısıt adları kolon sayılmamalı.
  for (const columns of Object.values(SCHEMA_MANIFEST)) {
    assert.ok(!columns.some((column) => /^(check|unique|primary|foreign)$/i.test(column)), `kısıt kolon sayıldı: ${columns.join()}`);
  }
});

test("taze veritabanı tek çağrıda kurulur ve doğrulamayı geçer", async () => {
  const db = createSqliteD1();
  try {
    assert.equal(await readSchemaVersion(db), 0);
    await assert.rejects(() => assertSchemaReady(db), SchemaNotReadyError);

    const result = await applyArchiveMigrations(db);
    assert.deepEqual(result, { applied: true, from: 0, to: ARCHIVE_SCHEMA_VERSION });
    assert.equal(await readSchemaVersion(db), ARCHIVE_SCHEMA_VERSION);
    await assertSchemaReady(db);

    // DDL'de bildirilen her kolon gerçekten oluşmuş olmalı.
    for (const [table, expected] of Object.entries(SCHEMA_MANIFEST)) {
      const actual = new Set(columnsOf(db, table));
      const missing = expected.filter((column) => !actual.has(column));
      assert.deepEqual(missing, [], `${table} tablosunda eksik kolon`);
    }
    // Veri sözlüğünün gerektirdiği tablolar ve kritik indeksler.
    const tables = tablesOf(db);
    for (const table of ["binary_objects", "entities", "parcel_entities", "document_entity_relations", "parcel_lineage", "document_types", "field_definitions", "vocabularies", "vocabulary_terms"]) {
      assert.ok(tables.includes(table), `${table} tablosu yok`);
    }
    const indexes = indexesOf(db);
    assert.ok(indexes.includes("binary_objects_single_original_unique"));
    assert.ok(indexes.includes("extracted_fields_document_field_value_unique"));
    assert.ok(indexes.includes("parcel_entities_identity_unique"));
    // Eski tek değer kısıtı geri gelmemeli.
    assert.ok(!indexes.includes("extracted_fields_document_name_unique"));
  } finally {
    db.close();
  }
});

test("ikinci çağrı hiçbir şey değiştirmez", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    const before = tablesOf(db).length;
    const second = await applyArchiveMigrations(db);
    assert.deepEqual(second, { applied: false, from: ARCHIVE_SCHEMA_VERSION, to: ARCHIVE_SCHEMA_VERSION });
    assert.equal(tablesOf(db).length, before);
  } finally {
    db.close();
  }
});

test("tohumlanan profil ve sözlükler tekrar çalıştırmada çoğalmaz", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    const counts = () => ({
      types: (db.raw.prepare("SELECT COUNT(*) c FROM document_types").get() as { c: number }).c,
      fields: (db.raw.prepare("SELECT COUNT(*) c FROM field_definitions").get() as { c: number }).c,
      terms: (db.raw.prepare("SELECT COUNT(*) c FROM vocabulary_terms").get() as { c: number }).c,
    });
    const first = counts();
    assert.ok(first.types >= 6 && first.fields >= 40 && first.terms >= 10, `tohum eksik: ${JSON.stringify(first)}`);

    // Sürümü düşürüp yeniden çalıştırmak yinelenen kayıt üretmemeli.
    db.raw.prepare("UPDATE schema_state SET version = 1 WHERE id = 'archive'").run();
    await applyArchiveMigrations(db);
    assert.deepEqual(counts(), first);

    // Kritik alanlar ADR-006 gereği doğrulama zorunlu olmalı.
    const violations = (db.raw.prepare(
      "SELECT COUNT(*) c FROM field_definitions WHERE is_critical = 1 AND extraction_policy <> 'VERIFY_REQUIRED'",
    ).get() as { c: number }).c;
    assert.equal(violations, 0);
  } finally {
    db.close();
  }
});

test("kısıtlar veritabanı düzeyinde uygulanır", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    db.raw.prepare(`INSERT INTO archive_documents (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
      VALUES ('d1', 'ARS-1', 'a.pdf', 'originals/d1/o1', 'application/pdf', 10, 'abc', 'a@b')`).run();

    // Bir belgenin yalnız bir asıl nesnesi olabilir.
    const object = (id: string) => `INSERT INTO binary_objects (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('${id}', 'd1', 'original', 'originals/d1/${id}', 'application/pdf', 10, 'abc')`;
    db.raw.prepare(object("o1")).run();
    assert.ok(rejects(db, object("o2")), "ikinci asıl nesne kabul edildi");

    // Geçersiz nesne sınıfı reddedilir.
    assert.ok(rejects(db, `INSERT INTO binary_objects (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('o3', 'd1', 'uydurma', 'originals/d1/o3', 'application/pdf', 10, 'abc')`));

    // Doğrulama durumu ve risk seviyesi kontrollü sözlükten olmalı.
    const field = (id: string, status: string, risk = "LOW") => `INSERT INTO extracted_fields
      (id, document_id, field_name, field_value, confidence, risk_level, page_number, bbox_json, evidence_text, model, verification_status)
      VALUES ('${id}', 'd1', 'ada', '32', 0.9, '${risk}', 1, '[]', '', 'm', '${status}')`;
    db.raw.prepare(field("f1", "SUGGESTED")).run();
    assert.ok(rejects(db, field("f2", "UYDURMA")), "geçersiz doğrulama durumu kabul edildi");
    assert.ok(rejects(db, field("f3", "SUGGESTED", "ÇOK")), "geçersiz risk seviyesi kabul edildi");

    // Aynı alanın ikinci değeri kabul edilir (çoklu değer), aynı sıra numarası edilmez.
    db.raw.prepare(`INSERT INTO extracted_fields
      (id, document_id, field_name, value_index, field_value, confidence, risk_level, page_number, bbox_json, evidence_text, model)
      VALUES ('f4', 'd1', 'ada', 1, '33', 0.9, 'LOW', 1, '[]', '', 'm')`).run();
    assert.ok(rejects(db, `INSERT INTO extracted_fields
      (id, document_id, field_name, value_index, field_value, confidence, risk_level, page_number, bbox_json, evidence_text, model)
      VALUES ('f5', 'd1', 'ada', 1, '34', 0.9, 'LOW', 1, '[]', '', 'm')`), "aynı value_index iki kez kabul edildi");

    // Kişi/kurum varlıkları KVKK envanteri tamamlanana kadar kapsam dışı.
    assert.ok(rejects(db, `INSERT INTO entities (id, entity_type, display_label, created_by)
      VALUES ('e1', 'PERSON', 'X', 'a@b')`), "PERSON varlığı kabul edildi");

    // Doğrulanmış ilişki doğrulayan olmadan kaydedilemez.
    db.raw.prepare("INSERT INTO entities (id, entity_type, display_label, created_by) VALUES ('e2', 'PARCEL', '32/2', 'a@b')").run();
    assert.ok(rejects(db, `INSERT INTO document_entity_relations
      (id, document_id, entity_id, relation_type, relation_source, verification_status, created_by)
      VALUES ('r1', 'd1', 'e2', 'SUBJECT', 'HUMAN', 'VERIFIED', 'a@b')`), "doğrulayansız VERIFIED kabul edildi");

    // Denetim kaydı güncellenemez ve silinemez.
    db.raw.prepare(`INSERT INTO audit_events (id, document_id, event_number, actor, action, event_hash, created_at)
      VALUES ('a1', 'd1', 1, 'a@b', 'document.received', 'h1', '2026-01-01')`).run();
    assert.ok(rejects(db, "UPDATE audit_events SET actor = 'x' WHERE id = 'a1'"), "denetim kaydı güncellendi");
    assert.ok(rejects(db, "DELETE FROM audit_events WHERE id = 'a1'"), "denetim kaydı silindi");
  } finally {
    db.close();
  }
});

/** Şema sürüm 1'in (tek değerli `extracted_fields`) asgari kurulumu. */
function installVersionOne(db: ReturnType<typeof createSqliteD1>) {
  db.raw.exec(`
    CREATE TABLE archive_documents (
      id TEXT PRIMARY KEY NOT NULL, reference_no TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL, document_type TEXT NOT NULL DEFAULT 'Tasnif bekliyor',
      unit TEXT NOT NULL DEFAULT 'Belirlenmedi', status TEXT NOT NULL DEFAULT 'queued',
      uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE ocr_pages (
      id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL, page_number INTEGER NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, full_text TEXT NOT NULL DEFAULT '',
      words_json TEXT NOT NULL DEFAULT '[]', average_confidence REAL NOT NULL DEFAULT 0,
      model TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE extracted_fields (
      id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL, field_name TEXT NOT NULL,
      field_value TEXT NOT NULL, normalized_value TEXT, confidence REAL NOT NULL,
      page_number INTEGER NOT NULL, bbox_json TEXT NOT NULL, evidence_text TEXT NOT NULL,
      model TEXT NOT NULL, needs_review INTEGER NOT NULL DEFAULT 1, corrected_value TEXT,
      corrected_by TEXT, corrected_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE UNIQUE INDEX extracted_fields_document_name_unique ON extracted_fields (document_id, field_name);
    CREATE INDEX extracted_fields_review_idx ON extracted_fields (needs_review);
    CREATE TABLE archive_users (
      email TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',
      unit TEXT NOT NULL DEFAULT '*', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  db.raw.prepare(`INSERT INTO archive_documents (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, document_type, unit, status, uploaded_by)
    VALUES ('doc1', 'ARS-2026-1', 'encumen.jpeg', 'originals/2026/doc1/encumen.jpeg', 'image/jpeg', 1000, 'sha1', 'Encümen karar sureti', 'Belirlenmedi', 'review', 'a@sivas.bel.tr')`).run();
  db.raw.prepare(`INSERT INTO ocr_pages (id, document_id, page_number, width, height, full_text, model)
    VALUES ('p1', 'doc1', 1, 971, 1600, 'Tapu Sici1 Müdürlüğü 1580 sayılı yasa', 'PP-OCRv5')`).run();
  const field = (id: string, name: string, value: string, needsReview: number, corrected: string | null) =>
    db.raw.prepare(`INSERT INTO extracted_fields (id, document_id, field_name, field_value, confidence, page_number, bbox_json, evidence_text, model, needs_review, corrected_value, corrected_by, corrected_at)
      VALUES (?, 'doc1', ?, ?, 0.95, 1, '[0,0,1,1]', 'kanit', 'PP-OCRv5', ?, ?, ?, ?)`)
      .run(id, name, value, needsReview, corrected, corrected ? "b@sivas.bel.tr" : null, corrected ? "2026-07-01" : null);
  field("ef1", "ada", "32", 0, null);
  field("ef2", "parcel", "2", 0, "2-A");
  field("ef3", "unit", "Belirlenmedi", 1, null);
  // Türkçe locale küçültmesiyle bozulmuş kimlik.
  db.raw.prepare("INSERT INTO archive_users (email, display_name, role) VALUES ('ıbrahim@sivas.bel.tr', 'İbrahim', 'reviewer')").run();
  db.raw.exec("CREATE TABLE schema_state (id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.raw.prepare("INSERT INTO schema_state (id, version) VALUES ('archive', 1)").run();
}

test("sürüm 1'den yükseltme veriyi korur ve tüm göçleri uygular", async () => {
  const db = createSqliteD1();
  try {
    installVersionOne(db);
    const result = await applyArchiveMigrations(db);
    assert.deepEqual(result, { applied: true, from: 1, to: ARCHIVE_SCHEMA_VERSION });

    // Çoklu değer modeli: tek değer kısıtı kalktı, doğrulama durumu türetildi.
    const fields = db.raw.prepare("SELECT id, field_name, verification_status, risk_level, verified_by, value_index FROM extracted_fields ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.equal(fields.length, 3, "alan değerleri kayboldu");
    assert.equal(fields[0].verification_status, "CONFIRMED");
    assert.equal(fields[1].verification_status, "CORRECTED");
    assert.equal(fields[1].verified_by, "b@sivas.bel.tr", "doğrulayan düzeltme kaydından türetilmedi");
    assert.equal(fields[2].verification_status, "SUGGESTED");
    assert.equal(fields[2].risk_level, "CRITICAL", "doldurulmamış kritik alan riski yükseltilmedi");
    assert.ok(!indexesOf(db).includes("extracted_fields_document_name_unique"));
    assert.ok(!columnsOf(db, "extracted_fields").includes("needs_review"), "türetilebilir kolon kaldırılmadı");

    // Nesne kaydı geriye dönük üretildi.
    const original = db.raw.prepare("SELECT object_key, sha256, generator FROM binary_objects WHERE document_id = 'doc1'").get() as Record<string, string>;
    assert.equal(original.object_key, "originals/2026/doc1/encumen.jpeg");
    assert.equal(original.sha256, "sha1");
    assert.equal(original.generator, "ingest-backfill");

    // Belge profile bağlandı.
    const document = db.raw.prepare("SELECT document_type_id, document_profile_version FROM archive_documents WHERE id = 'doc1'").get() as Record<string, string>;
    assert.ok(document.document_type_id?.includes("ENCUMEN_KARARI"), `profil bağlanmadı: ${document.document_type_id}`);
    assert.equal(document.document_profile_version, "1.0");
    const linked = db.raw.prepare("SELECT COUNT(*) c FROM extracted_fields WHERE field_definition_id IS NOT NULL").get() as { c: number };
    assert.equal(linked.c, 3, "alan tanımı bağı kurulmadı");

    // Türkçe locale ile bozulmuş e-posta onarıldı.
    const users = db.raw.prepare("SELECT email FROM archive_users").all() as Array<{ email: string }>;
    assert.deepEqual(users.map((user) => user.email), ["ibrahim@sivas.bel.tr"]);

    // Arama dizini yenilemesi göç içinde çalıştırılmaz, kuyruğa alınır: büyük
    // arşivde tek istekte bütün tabloyu dolaşmak zaman aşımı üretir.
    const beforeSlice = db.raw.prepare("SELECT search_text, raw_text FROM ocr_pages WHERE id = 'p1'").get() as Record<string, string>;
    assert.equal(beforeSlice.search_text, "", "göç sırasında dizin yenilendi");
    assert.equal(beforeSlice.raw_text, "");
    const queued = await readMaintenanceProgress(db);
    assert.equal(queued?.status, "PENDING");
    assert.equal(queued?.total, 1);

    // Bakım dilimi işi tamamlar ve dizini tek arama uygulamasıyla üretir.
    const slice = await runMaintenanceSlice(db);
    assert.equal(slice.claimed, true);
    assert.equal(slice.progress?.done, true);
    assert.equal(slice.progress?.remaining, 0);
    const page = db.raw.prepare("SELECT search_text FROM ocr_pages WHERE id = 'p1'").get() as Record<string, string>;
    assert.equal(page.search_text, "tapu sicil mudurlugu 1580 sayili yasa");
  } finally {
    db.close();
  }
});

test("istek doğrulaması: üretimde reddeder, yerelde göç uygular", async () => {
  const remote = createSqliteD1();
  try {
    // Üretim ana bilgisayarında bir istek şema değiştirmemeli.
    const response = await requireArchiveSchema(new Request("https://arsiv.sivas.bel.tr/api/documents"), remote);
    assert.ok(response, "geride şemayla istek kabul edildi");
    assert.equal(response.status, 503);
    const body = await response.json() as { error: string };
    assert.match(body.error, /api\/admin\/migrate/);
    assert.equal(await readSchemaVersion(remote), 0, "istek yolu şema oluşturdu");
    assert.deepEqual(tablesOf(remote), [], "istek yolu tablo yarattı");
  } finally {
    remote.close();
  }

  const local = createSqliteD1();
  try {
    // Yerel geliştirmede kolaylık için kendiliğinden uygulanır.
    const response = await requireArchiveSchema(new Request("http://localhost:3000/api/documents"), local);
    assert.equal(response, null);
    assert.equal(await readSchemaVersion(local), ARCHIVE_SCHEMA_VERSION);
  } finally {
    local.close();
  }
});

test("yarıda kalan göç sürüm damgalamaz", async () => {
  const db = createSqliteD1();
  try {
    installVersionOne(db);
    // `document_types` adında çakışan bir görünüm, tablo oluşturmayı bozar.
    db.raw.exec("CREATE VIEW document_types AS SELECT 1 AS x");
    await assert.rejects(() => applyArchiveMigrations(db));
    // Sürüm ilerlememeli: yeniden çalıştırma güvenli kalır.
    assert.equal(await readSchemaVersion(db), 1);
  } finally {
    db.close();
  }
});

test("v17 türev işi verisi kuşak kanıtlı v18 şemasına kayıpsız yükselir", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    // Dağıtılmış v17 biçimini gerçek tablo kısıtıyla yeniden kuruyoruz. Yeni
    // kolonlara bağlı indeksler v18 yapısal adımından önce çalışmamalıdır.
    db.raw.exec(`DROP TABLE derivative_jobs;
      CREATE TABLE derivative_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL UNIQUE REFERENCES archive_documents(id) ON DELETE CASCADE,
        source_binary_object_id TEXT NOT NULL REFERENCES binary_objects(id),
        status TEXT NOT NULL DEFAULT 'QUEUED',
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        failure_code TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX derivative_jobs_claim_idx
        ON derivative_jobs (status, next_attempt_at, lease_expires_at, created_at);`);
    db.raw.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
      VALUES ('v17-doc', 'ARS-V17', 'belge.pdf', 'originals/v17-doc/object',
        'application/pdf', 10, ?, 'a@b')`).run("a".repeat(64));
    db.raw.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('v17-source', 'v17-doc', 'original', 'originals/v17-doc/object',
        'application/pdf', 10, ?)`).run("a".repeat(64));
    db.raw.prepare(`INSERT INTO derivative_jobs
      (id, document_id, source_binary_object_id, status, attempt, max_attempts)
      VALUES ('v17-job', 'v17-doc', 'v17-source', 'RETRY', 2, 5)`).run();
    db.raw.prepare("UPDATE schema_state SET version = 17 WHERE id = 'archive'").run();

    await applyArchiveMigrations(db);
    assert.equal(await readSchemaVersion(db), ARCHIVE_SCHEMA_VERSION);
    const migrated = db.raw.prepare(`SELECT id, profile_version, status, attempt,
        renderer_image_digest, page_count, segment_count
      FROM derivative_jobs WHERE id = 'v17-job'`).get() as Record<string, unknown>;
    assert.equal(migrated.profile_version, "access-pdf-v1");
    assert.equal(migrated.status, "RETRY");
    assert.equal(migrated.attempt, 2);
    assert.equal(migrated.renderer_image_digest, null);
    assert.ok(columnsOf(db, "binary_objects").includes("derivative_generation_id"));
    assert.ok(indexesOf(db).includes("derivative_jobs_document_profile_unique"));

    // Eski belge için yeni profil işi açılabilir; aynı profil yinelenemez.
    db.raw.prepare(`INSERT INTO derivative_jobs
      (id, document_id, source_binary_object_id, profile_version)
      VALUES ('v18-job', 'v17-doc', 'v17-source', 'access-pdf-v2')`).run();
    assert.throws(() => db.raw.prepare(`INSERT INTO derivative_jobs
      (id, document_id, source_binary_object_id, profile_version)
      VALUES ('duplicate', 'v17-doc', 'v17-source', 'access-pdf-v1')`).run());
  } finally {
    db.close();
  }
});
test("görüntüleme erişim türevini, indirme aslı çözer", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    db.raw.prepare(`INSERT INTO archive_documents (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
      VALUES ('d9', 'ARS-9', 'tarama.jpeg', 'originals/d9/o9', 'image/jpeg', 900, 'sha-orijinal', 'a@b')`).run();
    db.raw.prepare(`INSERT INTO binary_objects (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('o9', 'd9', 'original', 'originals/d9/o9', 'image/jpeg', 900, 'sha-orijinal')`).run();

    // Türev yokken PDF DIŞI tür asılı sunmak zorunda kalır ama sınıf bildirilir.
    const withoutDerivative = await resolveViewableObject(db, "d9");
    assert.ok(withoutDerivative && isPendingDerivative(withoutDerivative));

    db.raw.prepare(`INSERT INTO binary_objects (id, document_id, object_class, object_key, media_type, byte_size, sha256, derived_from_id, generator)
      VALUES ('a9', 'd9', 'access', 'derivatives/d9/access/a9', 'image/jpeg', 120, 'sha-turev', 'o9', 'ocr:test')`).run();

    // Türev varken görüntüleme aslı açmaz.
    const viewable = await resolveViewableObject(db, "d9");
    assert.ok(viewable && !isPendingDerivative(viewable));
    assert.equal(viewable.objectClass, "access");
    assert.equal(viewable.object.object_key, "derivatives/d9/access/a9");
    assert.equal(viewable.object.sha256, "sha-turev");

    // İndirme her durumda aslı döner.
    const original = await resolveOriginalObject(db, "d9");
    assert.equal(original?.object_key, "originals/d9/o9");
    assert.equal(original?.sha256, "sha-orijinal");

    // Nesne kaydı olmayan tarihsel belge kabul alındısındaki konuma düşer.
    db.raw.prepare(`INSERT INTO archive_documents (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
      VALUES ('d10', 'ARS-10', 'eski.pdf', 'originals/2026/d10/eski.pdf', 'application/pdf', 10, 'sha-eski', 'a@b')`).run();
    const missingInventory = await resolveViewableObject(db, "d10");
    assert.equal(missingInventory, null);
  } finally {
    db.close();
  }
});

test("v19 anahtar taşıma şeması kaynak bekleme ve tasfiye kanıtıyla v20'ye yükselir", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    db.raw.exec("ALTER TABLE legacy_key_migrations DROP COLUMN source_retire_after");
    db.raw.exec("ALTER TABLE legacy_key_migrations DROP COLUMN source_disposed_at");
    db.raw.prepare("UPDATE schema_state SET version = 19 WHERE id = 'archive'").run();

    const result = await applyArchiveMigrations(db);
    assert.deepEqual(result, { applied: true, from: 19, to: ARCHIVE_SCHEMA_VERSION });
    const columns = db.raw.prepare("PRAGMA table_info(legacy_key_migrations)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "source_retire_after"));
    assert.ok(columns.some((column) => column.name === "source_disposed_at"));
  } finally {
    db.close();
  }
});
test("v21 erişim bileti şeması belge ve nesne sınıfı bağıyla v22'ye yükselir", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.raw.exec("DROP TRIGGER IF EXISTS access_sessions_binding_immutable");
    db.raw.exec("DROP TRIGGER IF EXISTS access_tickets_binding_immutable");
    db.raw.exec("DROP TRIGGER IF EXISTS access_tickets_binding_guard_insert");
    db.raw.exec("DROP TABLE access_sessions");
    db.raw.exec("DROP TABLE access_tickets");
    db.raw.exec(`CREATE TABLE access_tickets (
      id TEXT PRIMARY KEY NOT NULL, ticket_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL, binary_object_id TEXT NOT NULL REFERENCES binary_objects(id),
      scope TEXT NOT NULL, purpose TEXT NOT NULL, expires_at TEXT NOT NULL,
      consumed_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.raw.exec(`CREATE TABLE access_sessions (
      id TEXT PRIMARY KEY NOT NULL, session_hash TEXT NOT NULL UNIQUE,
      access_ticket_id TEXT NOT NULL UNIQUE REFERENCES access_tickets(id),
      user_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES archive_documents(id),
      binary_object_id TEXT NOT NULL REFERENCES binary_objects(id), object_class TEXT NOT NULL,
      purpose TEXT NOT NULL, idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    db.raw.exec("PRAGMA foreign_keys = ON");
    db.raw.prepare("UPDATE schema_state SET version = 21 WHERE id = 'archive'").run();

    const result = await applyArchiveMigrations(db);
    assert.deepEqual(result, { applied: true, from: 21, to: ARCHIVE_SCHEMA_VERSION });
    const columns = db.raw.prepare("PRAGMA table_info(access_tickets)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "document_id"));
    assert.ok(columns.some((column) => column.name === "object_class"));
    const triggers = db.raw.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'access_%'`).all() as Array<{ name: string }>;
    assert.deepEqual(triggers.map((row) => row.name).sort(), [
      "access_sessions_binding_immutable",
      "access_tickets_binding_guard_insert",
      "access_tickets_binding_immutable",
    ]);
  } finally {
    db.close();
  }
});
