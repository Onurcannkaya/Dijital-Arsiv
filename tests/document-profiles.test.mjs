import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("profil ve sözlük tabloları veri sözlüğüyle uyumlu", async () => {
  const [runtime, drizzle] = await Promise.all([read("lib/archive-schema.ts"), read("db/schema.ts")]);
  for (const table of ["vocabularies", "vocabulary_terms", "document_types", "field_definitions"]) {
    assert.ok(runtime.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} tablosu yok`);
  }
  // VERI_SOZLUGU.md §6 alan profili özellikleri.
  for (const column of ["cardinality", "requirement", "is_critical", "extraction_policy", "vocabulary_code", "profile_version", "valid_to"]) {
    assert.ok(runtime.includes(column), `${column} kolonu yok`);
  }
  // VERI_SOZLUGU.md §13: her sözlük kaydı sürüm, geçerlilik, sahip ve kaynak taşır.
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS vocabularies \([\s\S]*?owner TEXT NOT NULL,[\s\S]*?source TEXT NOT NULL,[\s\S]*?version TEXT NOT NULL/);
  // Drizzle aynası aynı tabloları tanımlar.
  for (const table of ["vocabularies", "vocabulary_terms", "document_types", "field_definitions"]) {
    assert.ok(drizzle.includes(`sqliteTable("${table}"`), `Drizzle aynasında ${table} yok`);
  }
});

test("çokluk ve zorunluluk sözlükleri veri sözlüğündeki kodlarla aynı", async () => {
  const runtime = await read("lib/archive-schema.ts");
  assert.match(runtime, /cardinality IN \('one', 'zero_or_one', 'one_or_more', 'many'\)/);
  assert.match(runtime, /requirement IN \('OPTIONAL', 'REQUIRED', 'REQUIRED_FOR_ARCHIVE'\)/);
  assert.match(runtime, /extraction_policy IN \('NONE', 'SUGGEST', 'VERIFY_REQUIRED'\)/);
  // MUDURLUK_BELGE_TURU_ENVANTERI.md §3 durum kodları.
  assert.match(runtime, /profile_status IN \('HYPOTHESIS', 'DISCOVERED', 'VALIDATED', 'PILOT', 'ACTIVE', 'RETIRED'\)/);
});

test("ADR-006 veritabanı kısıtıyla uygulanır", async () => {
  const [runtime, drizzle, seed] = await Promise.all([
    read("lib/archive-schema.ts"), read("db/schema.ts"), read("lib/archive-seed.ts"),
  ]);
  // Kritik alan her durumda insan onayı gerektirir.
  assert.match(runtime, /CHECK \(is_critical = 0 OR extraction_policy = 'VERIFY_REQUIRED'\)/);
  assert.match(drizzle, /field_definitions_critical_verify_check/);
  assert.match(seed, /field\.isCritical \? "VERIFY_REQUIRED" : "SUGGEST"/);
});

test("kurallar kodda değil profil verisinde tutulur", async () => {
  const [policy, seed, extractors] = await Promise.all([
    read("lib/field-policy.ts"), read("lib/archive-seed.ts"), read("services/ocr/app/extractors.py"),
  ]);
  // Alan politikası artık sabit alan tablosu içermez, tanım alır.
  assert.doesNotMatch(policy, /const definitions:/);
  assert.doesNotMatch(policy, /requiredByType/);
  assert.match(policy, /import type \{ DocumentProfile, FieldDefinition \}/);
  // Biçim kalıpları ve müdürlük listesi tohum verisinde.
  assert.match(seed, /PARCEL_TOKEN_PATTERN/);
  assert.match(seed, /UNIT_VOCABULARY_CODE/);
  // OCR servisi kendi müdürlük ve belge türü listesini tutmaz.
  assert.doesNotMatch(extractors, /Müdürlüğü"/);
  assert.doesNotMatch(extractors, /UNITS = \(/);
  assert.doesNotMatch(extractors, /DOCUMENT_TYPES = \{/);
  assert.match(extractors, /def extract_fields\(pages: list\[dict\[str, Any\]\], profile: dict\[str, Any\] \| None = None\)/);
});

test("sözlükler OCR isteğiyle taşınır ve sürümü sonuçla saklanır", async () => {
  const [processor, contract, main] = await Promise.all([
    read("app/api/jobs/process/route.ts"), read("lib/ocr-contract.ts"), read("services/ocr/app/main.py"),
  ]);
  assert.match(processor, /buildOcrProfile/);
  assert.match(processor, /body: JSON\.stringify\(\{[\s\S]*profile: ocrProfile/);
  assert.match(processor, /loadVocabularyTerms\(db, UNIT_VOCABULARY_CODE\)/);
  assert.match(contract, /OcrProfilePayload/);
  assert.match(contract, /vocabularyVersion/);
  assert.match(main, /def parse_profile/);
  assert.match(main, /extract_fields\(pages, document_profile\)/);
  // Bozuk profil sessizce yok sayılmaz.
  assert.match(main, /Profil verisi geçerli JSON değil/);
  // Çıkarımda kullanılan sözlük sürümü alan kaydına yazılır.
  assert.match(processor, /vocabulary_version/);
  assert.match(processor, /result\.vocabularyVersion/);
});

test("belge türü ve müdürlük kontrollü listeye bağlı", async () => {
  const [upload, fields] = await Promise.all([
    read("app/api/uploads/route.ts"), read("app/api/documents/[id]/fields/route.ts"),
  ]);
  // Yükleme serbest metin tür kabul etmez.
  assert.match(upload, /loadProfileByName/);
  assert.match(upload, /Belge türü yürürlükteki profiller arasında bulunamadı/);
  assert.match(upload, /Müdürlük değeri kontrollü listede bulunmuyor/);
  assert.match(upload, /requestedDocumentType: profile\.name/);
  // Doğrulama sırasında tür değişikliği profil bağını da taşır.
  assert.match(fields, /yürürlükteki bir belge türü profili değil/);
  assert.match(fields, /document_type_id = \?/);
  // Zorlanan sözlükte liste dışı değer reddedilir, zorlanmayanda uyarı verilir.
  assert.match(fields, /vocabularyViolation/);
  assert.match(fields, /definition\?\.enforceVocabulary/);
});

test("arşivleme zorunluluğu profil kurallarından okunur", async () => {
  const [approve, policy] = await Promise.all([
    read("app/api/documents/[id]/approve/route.ts"), read("lib/field-policy.ts"),
  ]);
  assert.match(policy, /verificationRequiredFields/);
  assert.match(approve, /verificationRequiredFields\(profile\)/);
  assert.match(approve, /requiredFields\(profile\)/);
  // Denetim kaydı hangi profil sürümüyle arşivlendiğini saklar.
  assert.match(approve, /profileVersion: profile\.profileVersion/);
  assert.match(approve, /profileStatus: profile\.profileStatus/);
});

test("arayüz seçenekleri sabit liste yerine API'den gelir", async () => {
  const [upload, review, profiles] = await Promise.all([
    read("app/archive/upload-dialog.tsx"), read("app/archive/document-review.tsx"), read("app/api/profiles/route.ts"),
  ]);
  assert.match(upload, /fetch\("\/api\/profiles"\)/);
  // Eski sabit belge türü ve müdürlük listeleri kalmadı.
  assert.doesNotMatch(upload, /<option>Yapı kullanma izin belgesi<\/option>/);
  assert.doesNotMatch(upload, /<option>İtfaiye Müdürlüğü<\/option>/);
  assert.match(review, /profile-strip/);
  assert.match(review, /profileStatusLabels/);
  assert.match(review, /detail\.vocabularies/);
  assert.match(profiles, /document\.read/);
  assert.match(profiles, /listActiveProfiles/);
});

test("profil önbelleği açıkça temizlenebilir", async () => {
  const profile = await read("lib/document-profile.ts");
  assert.match(profile, /CACHE_TTL_MS/);
  assert.match(profile, /export function clearProfileCache/);
  // Tanınmayan tür sessizce varsayılana düşmemeli.
  assert.match(profile, /export async function loadProfileByName/);
  assert.match(profile, /Varsayılan profile düşmez/);
});

test("tohumlanan profiller onaysız doğrulanmış sayılmaz", async () => {
  const [seed, schema] = await Promise.all([read("lib/archive-seed.ts"), read("lib/archive-schema.ts")]);
  // MUDURLUK_BELGE_TURU_ENVANTERI.md §9: onay olmadan VALIDATED olmaz.
  assert.match(schema, /'HYPOTHESIS'/);
  assert.doesNotMatch(seed, /profileStatus: "VALIDATED"/);
  // Mahalle sözlüğü uydurma değerle doldurulmadı.
  assert.match(seed, /NEIGHBORHOOD_VOCABULARY_CODE/);
  assert.match(seed, /terms: \[\]/);
  // Tohumlama yalnız eksikleri ekler.
  assert.match(schema, /ON CONFLICT\(code, profile_version\) DO NOTHING/);
  assert.match(schema, /ON CONFLICT\(document_type_id, field_code\) DO NOTHING/);
});
