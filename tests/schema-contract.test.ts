import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ARCHIVE_SCHEMA_VERSION, SCHEMA_MANIFEST, archiveMigrationSteps } from "../lib/archive-schema.ts";

/**
 * Şema sözleşmesi ve sapma denetimi.
 *
 * Yetkili DDL kaynağı `lib/archive-schema.ts` dosyasıdır. `db/schema.ts` yalnız
 * Drizzle tip aynasıdır ve sorgu üretiminde kullanılmaz; buradaki karşılaştırma
 * ikisinin **kolon düzeyinde** ayrışmasını engeller. Tablo adı karşılaştırması
 * yeterli değildi: bir kolonun yalnız tek tanımda eklenmesi görünmüyordu.
 */

const runtimeSchema = await readFile(new URL("../lib/archive-schema.ts", import.meta.url), "utf8");
const drizzleSource = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");

/** `db/schema.ts` içindeki her `sqliteTable` bloğundan kolon adlarını çıkarır. */
function drizzleTableColumns(source: string): Record<string, string[]> {
  const tables: Record<string, string[]> = {};
  const pattern = /sqliteTable\("([a-z0-9_]+)",\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const [, table] = match;
    // Kolon nesnesinin kapanışına kadar oku (parantez derinliği ile).
    let depth = 1;
    let index = pattern.lastIndex;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      index += 1;
    }
    const body = source.slice(pattern.lastIndex, index - 1);
    // `sha256`, `previous_sha256` gibi rakam içeren kolon adları da yakalanmalı.
    const columns = [...body.matchAll(/\b(?:text|integer|real|blob|numeric)\("([a-z0-9_]+)"/g)].map((entry) => entry[1]);
    tables[table] = columns;
  }
  return tables;
}

const drizzleTables = drizzleTableColumns(drizzleSource);

test("çalışma zamanı DDL ile Drizzle şeması aynı tabloları tanımlar", () => {
  const runtime = Object.keys(SCHEMA_MANIFEST).sort();
  const drizzle = Object.keys(drizzleTables).sort();
  assert.deepEqual(drizzle.filter((table) => !runtime.includes(table)), [], "Drizzle'da fazla tablo var");
  assert.deepEqual(runtime.filter((table) => !drizzle.includes(table)), [], "Drizzle aynasında eksik tablo var");
});

test("her tablonun kolonları iki tanımda birebir aynı", () => {
  for (const [table, expected] of Object.entries(SCHEMA_MANIFEST)) {
    const mirrored = new Set(drizzleTables[table] ?? []);
    const missing = expected.filter((column) => !mirrored.has(column));
    const extra = [...mirrored].filter((column) => !expected.includes(column));
    assert.deepEqual(missing, [], `${table}: Drizzle aynasında eksik kolon`);
    assert.deepEqual(extra, [], `${table}: Drizzle aynasında fazla kolon`);
  }
});

test("veri sözlüğünün gerektirdiği tablolar şemada bulunur", () => {
  for (const table of [
    "binary_objects", "entities", "parcel_entities", "address_entities",
    "building_entities", "document_entity_relations", "parcel_lineage",
    "document_types", "field_definitions", "vocabularies", "vocabulary_terms",
  ]) {
    assert.ok(table in SCHEMA_MANIFEST, `${table} tablosu tanımlı değil`);
  }
});

test("çoklu değer kısıtı tek değer varsayımını kaldırır", () => {
  assert.doesNotMatch(runtimeSchema, /extracted_fields_document_name_unique/);
  assert.match(runtimeSchema, /extracted_fields_document_field_value_unique ON extracted_fields \(document_id, field_name, value_index\)/);
  assert.ok(!SCHEMA_MANIFEST.extracted_fields.includes("needs_review"), "türetilebilir kolon geri geldi");
  assert.doesNotMatch(drizzleSource, /needsReview/);
});

test("şema değişikliği sürüm ve göç adımı olmadan yayımlanamaz", () => {
  // Her tablo/kolon eklemesi sürüm artışı ve göç adımı gerektirir.
  const steps = archiveMigrationSteps.map((step) => step.version);
  assert.ok(steps.length > 0, "göç adımı listesi bulunamadı");
  assert.equal(Math.max(...steps), ARCHIVE_SCHEMA_VERSION, "en yüksek göç adımı sürümle uyuşmuyor");
  assert.deepEqual([...steps].sort((left, right) => left - right), steps, "göç adımları sürüm sırasında değil");
});

test("veri adımları tablolar kurulduktan sonra çalışır", () => {
  // Yeni tabloya yazan bir adım yapısal listede çalışırsa "no such table" verir.
  assert.match(runtimeSchema, /const structuralMigrations: MigrationStep\[\]/);
  assert.match(runtimeSchema, /const dataMigrations: MigrationStep\[\]/);
  const structuralAt = runtimeSchema.indexOf("for (const migration of structuralMigrations)");
  const tablesAt = runtimeSchema.indexOf("await db.batch(tableStatements.map");
  const dataAt = runtimeSchema.indexOf("for (const migration of dataMigrations)");
  assert.ok(structuralAt > 0 && tablesAt > structuralAt, "yapısal adımlar tablo kurulumundan sonra çalışıyor");
  assert.ok(dataAt > tablesAt, "veri adımları tablo kurulumundan önce çalışıyor");
});

test("istek yolu şema değiştirmez", async () => {
  const storage = await readFile(new URL("../lib/archive-storage.ts", import.meta.url), "utf8");
  // Rotalar yalnız doğrular; DDL yetkili uç noktadan veya yerel geliştirmede çalışır.
  assert.match(runtimeSchema, /export async function assertSchemaReady/);
  assert.match(runtimeSchema, /export async function applyArchiveMigrations/);
  assert.match(runtimeSchema, /export async function requireArchiveSchema/);
  assert.match(runtimeSchema, /if \(!isLocalRequest\(request\)\) return jsonError\(error\.message, 503\)/);
  assert.doesNotMatch(runtimeSchema, /export async function ensureArchiveSchema/);
  assert.match(storage, /requireArchiveSchema/);

  const routes = [
    "app/api/documents/route.ts", "app/api/documents/[id]/route.ts",
    "app/api/documents/[id]/fields/route.ts", "app/api/documents/[id]/file/route.ts",
    "app/api/documents/[id]/approve/route.ts", "app/api/documents/[id]/relations/route.ts",
    "app/api/documents/[id]/text/route.ts", "app/api/jobs/process/route.ts",
    "app/api/me/route.ts", "app/api/overview/route.ts", "app/api/profiles/route.ts",
  ];
  for (const route of routes) {
    const source = await readFile(new URL(`../${route}`, import.meta.url), "utf8");
    assert.match(source, /requireArchiveSchema\(request, bindings\.DB\)/, `${route}: şema doğrulaması yok`);
    assert.doesNotMatch(source, /applyArchiveMigrations/, `${route}: istek yolunda göç uyguluyor`);
  }
});

test("göç uç noktası ortam sırrıyla korunur", async () => {
  const migrate = await readFile(new URL("../app/api/admin/migrate/route.ts", import.meta.url), "utf8");
  // Rol tabanlı yetki kullanılamaz: taze veritabanında kullanıcı tablosu yoktur.
  assert.match(migrate, /ARCHIVE_MIGRATION_TOKEN/);
  assert.match(migrate, /token\.trim\(\)\.length < 16/);
  assert.match(migrate, /göç uç noktası kapalı/);
  assert.match(migrate, /Bearer \$\{token\}/);
  assert.doesNotMatch(migrate, /authorizeRequest/);
});

test("denetim kayıtları güncelleme ve silmeye kapalı kalır", () => {
  assert.match(runtimeSchema, /audit_events_no_update/);
  assert.match(runtimeSchema, /audit_events_no_delete/);
});
