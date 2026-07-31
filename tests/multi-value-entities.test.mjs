import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("alan politikası tek merkezde tanımlıdır", async () => {
  const [policy, profiles, processor, fields, approve] = await Promise.all([
    read("lib/field-policy.ts"),
    read("lib/document-profile.ts"),
    read("app/api/jobs/process/route.ts"),
    read("app/api/documents/[id]/fields/route.ts"),
    read("app/api/documents/[id]/approve/route.ts"),
  ]);
  // Çokluk, kritiklik, zorunluluk ve risk kuralları tek dosyada.
  assert.match(profiles, /field_definitions/);
  assert.match(profiles, /cardinality: Cardinality/);
  assert.match(policy, /DocumentProfile, FieldDefinition/);
  assert.match(policy, /requiredFields/);
  assert.match(policy, /assessRisk/);
  // Rotalar kendi kuralını yazmaz, politikayı çağırır (ADR-008).
  for (const source of [processor, fields, approve]) {
    assert.match(source, /lib\/field-policy/);
    assert.doesNotMatch(source, /requiredByType/);
  }
  assert.match(processor, /requiredFields\(profile\)/);
  assert.match(processor, /assessRisk/);
});

test("risk seviyesi model güveninden ayrı hesaplanır", async () => {
  const [policy, seed] = await Promise.all([
    read("lib/field-policy.ts"),
    read("lib/archive-seed.ts"),
  ]);
  // PROJE_PLANI.md 2. düzeltme maddesi: güven tek başına risk değildir.
  assert.match(policy, /formatViolation/);
  assert.match(policy, /origin === "HUMAN"/);
  assert.match(policy, /RiskLevel = "LOW" \| "MEDIUM" \| "HIGH" \| "CRITICAL"/);
  // Ada ve parsel biçim kuralı hukuki ekleri kabul eder.
  const { source } = /PARCEL_TOKEN_PATTERN = "(?<source>\^\[0-9\]\{1,7\}[^"]*)"/.exec(seed)?.groups ?? {};
  assert.ok(source, "ada/parsel biçim kuralı bulunamadı");
});

test("OCR çok değerli alan yazar ve tek değerli alanı indirger", async () => {
  const processor = await read("app/api/jobs/process/route.ts");
  assert.match(processor, /isMultiValueField/);
  assert.match(processor, /value_index/);
  assert.match(processor, /field_definition_id, value_index/);
  assert.match(processor, /verification_status, origin\)/);
  assert.match(processor, /'SUGGESTED', 'OCR'/);
  // OCR önerisi yetkili kaynağın üzerine yazmaz.
  assert.match(processor, /isUnclassified = currentProfile\.code === DEFAULT_DOCUMENT_TYPE_CODE/);
  assert.match(processor, /appliedProfile = detectedProfile/);
  assert.match(processor, /document\.unit === UNSET_UNIT \? suggestedUnit : null/);
});

test("OCR eşleşen ada/parsel için varlık ilişkisi önerir", async () => {
  const [processor, extractors, contract] = await Promise.all([
    read("app/api/jobs/process/route.ts"),
    read("services/ocr/app/extractors.py"),
    read("lib/ocr-contract.ts"),
  ]);
  assert.match(extractors, /parcel-\{parcel_group\}/);
  assert.match(contract, /group\?: string \| null/);
  assert.match(processor, /parcelGroups/);
  assert.match(processor, /resolveParcelEntity/);
  // Öneri doğrulanmış hukuki ilişki sayılmaz.
  assert.match(processor, /relationType: "TEXT_MENTION"/);
  assert.match(processor, /verificationStatus: "SUGGESTED"/);
  // Yeniden işlemede personel onaylı ilişkiler korunur.
  assert.match(processor, /relation_source = 'OCR' AND verification_status = 'SUGGESTED'/);
});

test("doğrulama API'si değer bazında onay, düzeltme, reddetme ve ekleme yapar", async () => {
  const route = await read("app/api/documents/[id]/fields/route.ts");
  assert.match(route, /"confirm", "correct", "reject"/);
  assert.match(route, /verification_status = 'CONFIRMED'/);
  assert.match(route, /verification_status = 'CORRECTED'/);
  assert.match(route, /verification_status = 'REJECTED'/);
  assert.match(route, /origin, verified_by, verified_at\)/);
  // Tek değerli alanda reddetme yasak, düzeltme zorunlu.
  assert.match(route, /tek değerli bir alandır; reddetmek yerine düzeltilmelidir/);
  assert.match(route, /tek değerli bir alandır; yeni değer eklenemez/);
  // Boş alan onaylanamaz.
  assert.match(route, /alanı boş onaylanamaz/);
  // Müdürlük kapsamı korunur.
  assert.match(route, /Belgeyi müdürlük kapsamınızın dışına taşıyamazsınız/);
  // Biçim uyarısı kaydı engellemez, riski yükseltir ve bildirilir.
  assert.match(route, /formatViolation/);
  assert.match(route, /warnings:/);
  // Eski tek değer davranışı kalmadı.
  assert.doesNotMatch(route, /needs_review/);
  assert.doesNotMatch(route, /AND field_name = \?/);
});

test("varlık ilişkisi API'si parsel ve adres için çoktan çoğa kayıt tutar", async () => {
  const [route, entities] = await Promise.all([
    read("app/api/documents/[id]/relations/route.ts"),
    read("lib/entities.ts"),
  ]);
  assert.match(route, /document\.read/);
  assert.match(route, /document\.review/);
  assert.match(route, /resolveParcelEntity/);
  assert.match(route, /resolveAddressEntity/);
  assert.match(route, /relationSource: "HUMAN"/);
  assert.match(route, /verificationStatus: "VERIFIED"/);
  assert.match(route, /relation\.verified/);
  assert.match(route, /relation\.rejected/);
  assert.match(route, /Arşivlenmiş belgenin ilişkileri değiştirilemez/);
  // Dış kimlik yoksa varlık geçici kalır; hukuki kimlik yerine geçmez.
  assert.match(entities, /externalId \? "ACTIVE" : "PROVISIONAL"/);
  assert.match(entities, /normalizeParcelToken/);
  // Doğrulanmış ilişki OCR önerisiyle geri alınmaz.
  assert.match(entities, /WHEN document_entity_relations\.verification_status = 'VERIFIED'/);
});

test("ada ve parsel değerlerindeki hukuki ekler korunur", async () => {
  const entities = await read("lib/entities.ts");
  // Yalnız ASCII harfleri büyütülür; Türkçe locale dönüşümü uygulanmaz.
  assert.match(entities, /replace\(\/\[a-z\]\/g, \(letter\) => letter\.toUpperCase\(\)\)/);
  assert.doesNotMatch(entities, /toLocaleUpperCase/);
});

test("arşivleme kapısı bekleyen değer, metin ve ilişki bırakmaz", async () => {
  const approve = await read("app/api/documents/[id]/approve/route.ts");
  assert.match(approve, /pendingCritical/);
  assert.match(approve, /row\.verification_status === "SUGGESTED"/);
  assert.match(approve, /verification_status = 'SUGGESTED' THEN 1 ELSE 0 END\) AS pending/);
  assert.match(approve, /Kontrol bekleyen alanlar tamamlanmadan belge arşivlenemez/);
  assert.match(approve, /Tam metin personel tarafından onaylanmadan belge arşivlenemez/);
  assert.match(approve, /Kontrol bekleyen varlık ilişkileri karara bağlanmadan belge arşivlenemez/);
  // Belge türü profilindeki her zorunlu alan için kullanılabilir bir değer şart.
  assert.match(approve, /doğrulanmış bir değer olmadan arşivlenemez/);
  assert.match(approve, /requiredFields\(profile\)/);
});

test("nesne kaydı asıl dosyanın yetkili listesidir", async () => {
  const [schema, file, ticket, processor, storage] = await Promise.all([
    read("lib/archive-schema.ts"),
    read("app/api/documents/[id]/file/route.ts"),
    read("app/api/documents/[id]/access-ticket/route.ts"),
    read("app/api/jobs/process/route.ts"),
    read("lib/archive-storage.ts"),
  ]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS binary_objects/);
  assert.match(schema, /binary_objects_single_original_unique/);
  // Depolama konumu artık nesne kaydından çözülür; F1.9'da çözüm bilet
  // üretiminde yapılır ve dosya rotası kayıtlı ad alanından okur.
  assert.match(storage, /resolveOriginalObject/);
  assert.match(ticket, /resolveOriginalObject/);
  assert.match(file, /getObjectReaderForNamespace/);
  assert.match(file, /servable\.object_key/);
  assert.match(processor, /resolveOriginalObject/);
});

test("liste ve arama çok değerli alanları ve doğrulanmış ilişkileri kapsar", async () => {
  const documents = await read("app/api/documents/route.ts");
  assert.match(documents, /group_concat/);
  assert.match(documents, /f\.verification_status <> 'REJECTED'/);
  // Doğrulanmamış öneri belgeyi bir parsel altında görünür yapmamalıdır.
  assert.match(documents, /r\.verification_status = 'VERIFIED'/);
  assert.match(documents, /pending_values/);
});

test("doğrulama ekranı değer kimliğiyle çalışır ve ilişki panelini gösterir", async () => {
  const [review, relations] = await Promise.all([
    read("app/archive/document-review.tsx"),
    read("app/archive/entity-relations.tsx"),
  ]);
  assert.match(review, /fieldGroups/);
  assert.match(review, /valuesById/);
  assert.match(review, /EntityRelations/);
  assert.match(review, /Bu değeri reddet/);
  assert.match(review, /değeri ekle/);
  assert.match(review, /Nesne kayıtları/);
  // Eski alan adına göre anahtarlanan taslak kalmadı.
  assert.doesNotMatch(review, /needsReview/);
  assert.match(relations, /Parsel ekle/);
  assert.match(relations, /Adres ekle/);
  assert.match(relations, /geçici kimlikli/);
  assert.match(relations, /Doğrula/);
  assert.match(relations, /Reddet/);
});
