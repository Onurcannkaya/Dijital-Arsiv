import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSchema = await readFile(new URL("../lib/archive-schema.ts", import.meta.url), "utf8");
const drizzleSchema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

function runtimeTables(source) {
  return new Set([...source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)]
    .map((match) => match[1])
    // Göç sırasında geçici olarak kurulan ara tablo şema yüzeyi değildir.
    .filter((name) => name !== "extracted_fields_multivalue"));
}

function drizzleTables(source) {
  return new Set([...source.matchAll(/sqliteTable\("([a-z_]+)"/g)].map((match) => match[1]));
}

test("çalışma zamanı DDL ile Drizzle şeması aynı tabloları tanımlar", () => {
  const runtime = runtimeTables(runtimeSchema);
  const drizzle = drizzleTables(drizzleSchema);
  const missingInDrizzle = [...runtime].filter((table) => !drizzle.has(table));
  const missingInRuntime = [...drizzle].filter((table) => !runtime.has(table));
  assert.deepEqual(missingInDrizzle, [], `Drizzle şemasında eksik tablo: ${missingInDrizzle.join(", ")}`);
  assert.deepEqual(missingInRuntime, [], `Çalışma zamanı DDL'inde eksik tablo: ${missingInRuntime.join(", ")}`);
});

test("veri sözlüğünün gerektirdiği tablolar şemada bulunur", () => {
  const runtime = runtimeTables(runtimeSchema);
  for (const table of [
    "binary_objects", "entities", "parcel_entities", "address_entities",
    "building_entities", "document_entity_relations", "parcel_lineage",
  ]) {
    assert.ok(runtime.has(table), `${table} tablosu tanımlı değil`);
  }
});

test("çoklu değer kısıtı tek değer varsayımını kaldırır", () => {
  // Eski tek değer kısıtı hiçbir yerde yeniden kurulmamalıdır.
  assert.doesNotMatch(runtimeSchema, /extracted_fields \(document_id, field_name\)\s*$/m);
  assert.doesNotMatch(runtimeSchema, /extracted_fields_document_name_unique/);
  assert.match(runtimeSchema, /extracted_fields_document_field_value_unique ON extracted_fields \(document_id, field_name, value_index\)/);
  // Türetilebilir `needs_review` kolonu yerini doğrulama durumuna bıraktı.
  assert.match(runtimeSchema, /verification_status IN \('SUGGESTED', 'CONFIRMED', 'CORRECTED', 'REJECTED'\)/);
  assert.doesNotMatch(drizzleSchema, /needsReview/);
});

test("bir belgenin yalnız bir asıl nesnesi olabilir", () => {
  assert.match(runtimeSchema, /binary_objects_single_original_unique ON binary_objects \(document_id\) WHERE object_class = 'original'/);
  assert.match(runtimeSchema, /object_class IN \('original', 'access', 'ocr', 'preservation', 'thumbnail', 'quarantine', 'temporary'\)/);
});

test("parsel kimliği yalnız ada ve parsel değeriyle tekil sayılmaz", () => {
  // ANA_SISTEM_TASARIM_BELGESI.md §7.5: ilçe ve kadastro mahallesi kimliğe girer.
  assert.match(runtimeSchema, /parcel_entities_identity_unique ON parcel_entities \(district_code, cadastral_neighborhood, block_no, parcel_no\)/);
  // Ada ve parsel metindir; hukuki ekler korunur.
  assert.match(runtimeSchema, /block_no TEXT NOT NULL/);
  assert.match(runtimeSchema, /parcel_no TEXT NOT NULL/);
});

test("ilişki ve soy sözlükleri veri sözlüğüyle aynıdır", () => {
  for (const code of ["SUBJECT", "AFFECTS", "ATTACHMENT_REFERENCE", "NEIGHBOR", "PARTY", "HISTORICAL_LINK", "SPATIAL_INTERSECTION", "TEXT_MENTION"]) {
    assert.ok(runtimeSchema.includes(`'${code}'`), `${code} ilişki türü şemada yok`);
  }
  for (const code of ["SUBDIVISION", "MERGE", "RENUMBER", "BOUNDARY_CORRECTION", "OTHER"]) {
    assert.ok(runtimeSchema.includes(`'${code}'`), `${code} soy olayı şemada yok`);
  }
});

test("kişi ve kurum varlıkları KVKK envanteri tamamlanana kadar kapsam dışıdır", () => {
  assert.match(runtimeSchema, /entity_type IN \('PARCEL', 'ADDRESS', 'BUILDING', 'BUILDING_UNIT'\)/);
  assert.doesNotMatch(runtimeSchema, /'PERSON'/);
});

test("şema sürüm kapısı her istekte tüm DDL'i çalıştırmaz", () => {
  assert.match(runtimeSchema, /ARCHIVE_SCHEMA_VERSION = \d+/);
  assert.match(runtimeSchema, /SELECT version FROM schema_state WHERE id = 'archive'/);
  assert.match(runtimeSchema, /if \(current === ARCHIVE_SCHEMA_VERSION\) return/);
});

test("göç adımları sürüme göre planlanır, kolon yokluğuna göre değil", () => {
  // Kolon sniffing ile planlama, sonradan eklenen kolonu sessizce atlar.
  assert.match(runtimeSchema, /const migrations: Array<\{ version: number/);
  assert.match(runtimeSchema, /if \(current < migration\.version\) await migration\.run\(db\)/);
});

test("eksik şema sürüm damgalanmadan önce hataya dönüşür", () => {
  assert.match(runtimeSchema, /async function assertExpectedColumns/);
  assert.match(runtimeSchema, /await assertExpectedColumns\(db\);/);
  assert.match(runtimeSchema, /Arşiv şeması eksik/);
  // Doğrulama, sürüm yazımından önce çalışmalıdır.
  const validateAt = runtimeSchema.indexOf("await assertExpectedColumns(db);");
  const stampAt = runtimeSchema.indexOf("INSERT INTO schema_state (id, version, updated_at)");
  assert.ok(validateAt > 0 && stampAt > validateAt, "sürüm damgası doğrulamadan önce yazılıyor");
});

test("denetim kayıtları güncelleme ve silmeye kapalı kalır", () => {
  assert.match(runtimeSchema, /audit_events_no_update/);
  assert.match(runtimeSchema, /audit_events_no_delete/);
});
