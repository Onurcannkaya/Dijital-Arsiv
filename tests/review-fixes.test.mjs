import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("görüntüleme erişim türevini, indirme aslı sunar", async () => {
  const [route, ticketRoute, storage, contract, main, processor] = await Promise.all([
    read("app/api/documents/[id]/file/route.ts"),
    read("app/api/documents/[id]/access-ticket/route.ts"),
    read("lib/archive-storage.ts"),
    read("lib/ocr-contract.ts"),
    read("services/ocr/app/main.py"),
    read("app/api/jobs/process/route.ts"),
  ]);
  // F1.9: nesne çözümü bilet üretiminde yapılır ve bilet nesneye sabitlenir;
  // görüntüleme türevi, indirme aslı çözer.
  assert.match(ticketRoute, /resolveViewableObject/);
  assert.match(ticketRoute, /scope === "DOWNLOAD"\s*\n?\s*\?\s*await resolveOriginalObject/);
  assert.match(storage, /resolveViewableObject/);
  // Sunulan sınıf denetime yazılır: hangi nesne sınıfının verildiği görünür.
  assert.match(route, /servedObjectClass: servable\.object_class/);
  assert.match(route, /"x-archive-object-class"/);
  // Türev OCR servisinde üretilir ve nesne kaydına bağlanır.
  assert.match(main, /def build_access_derivative/);
  assert.match(main, /ACCESS_DERIVATIVE_MAX_EDGE/);
  assert.match(contract, /accessDerivative/);
  assert.match(processor, /object_class, object_key, storage_provider, bucket_or_namespace,\s*\n\s*media_type, byte_size, sha256, derived_from_id, generator\)/);
  assert.match(processor, /'access'/);
  assert.match(processor, /derivatives\/\$\{document\.id\}\/access\//);
});

test("erişim türevi olmayan belgeler raporlanır", async () => {
  const overview = await read("app/api/overview/route.ts");
  assert.match(overview, /without_access/);
  assert.match(overview, /withoutAccessDerivative/);
});

test("liste sunucuda sayfalanır ve durum sunucuda süzülür", async () => {
  const [route, workspace] = await Promise.all([
    read("app/api/documents/route.ts"),
    read("app/archive/workspace.tsx"),
  ]);
  // Sabit LIMIT 50 kalmadı; sınır istemciden gelir ve üst sınırı sunucu koyar.
  assert.doesNotMatch(route, /LIMIT 50/);
  assert.match(route, /MAX_PAGE_LIMIT = 200/);
  assert.match(route, /readPageRequest/);
  assert.match(route, /nextCursor/);
  // Anahtar kümesi sayfalama; OFFSET kullanılmaz.
  assert.match(route, /d\.created_at < \? OR \(d\.created_at = \? AND d\.id < \?\)/);
  assert.match(route, /ORDER BY d\.created_at DESC, d\.id DESC LIMIT \?/);
  assert.doesNotMatch(route, /LIMIT \? OFFSET/);
  // Durum süzmesi sunucuda; istemci süzmesi kalmadı.
  assert.match(route, /d\.status IN \(/);
  assert.match(workspace, /viewStatuses/);
  assert.match(workspace, /parameters\.set\("status"/);
  assert.doesNotMatch(workspace, /filter\(row=>row\.rawStatus/);
  // Sonraki sayfa arayüzde açıkça sunulur.
  assert.match(workspace, /Daha fazla göster/);
});

test("doğrulama kuyruğu ve göstergesi aynı durumları sayar", async () => {
  const [workspace, overview] = await Promise.all([
    read("app/archive/workspace.tsx"),
    read("app/api/overview/route.ts"),
  ]);
  // Kuyruk `review` + `ready`; gösterge de ikisini birlikte saymalı.
  assert.match(workspace, /review: \["review", "ready"\]/);
  assert.match(overview, /AS review/);
  assert.match(overview, /AS ready/);
  assert.match(workspace, /reviewPending/);
});

test("arama dizini yenilemesi kilitli ve kaldığı yerden devam eden bakım işidir", async () => {
  const [schema, endpoint] = await Promise.all([
    read("lib/archive-schema.ts"),
    read("app/api/admin/maintenance/route.ts"),
  ]);
  // Göç yalnız kuyruğa alır; bütün arşivi tek istekte dolaşmaz.
  assert.match(schema, /async function enqueueSearchReindex/);
  assert.match(schema, /version: 6, run: enqueueSearchReindex/);
  assert.doesNotMatch(schema, /async function recomputeSearchText/);
  // İşleme kilitli, imleçli ve sınırlı dilimlerde.
  assert.match(schema, /export async function runMaintenanceSlice/);
  assert.match(schema, /locked_until = datetime\('now', '\+/);
  assert.match(schema, /WHERE \(\? IS NULL OR id > \?\) ORDER BY id LIMIT \?/);
  assert.match(schema, /SET cursor = \?, processed = \?/);
  assert.match(schema, /status = 'FAILED'/);
  assert.match(endpoint, /users\.manage/);
  assert.match(endpoint, /runMaintenanceSlice/);
});

test("veritabanı hataları şema sürümü sıfır sayılmaz", async () => {
  const schema = await read("lib/archive-schema.ts");
  assert.match(schema, /function isMissingTableError/);
  assert.match(schema, /no such table/);
  assert.match(schema, /if \(isMissingTableError\(error\)\) return 0;\s*\n\s*throw error;/);
});

test("Node sürüm sözleşmesi TypeScript testlerini kapsar", async () => {
  const manifest = JSON.parse(await read("package.json"));
  // Tür sıyırma Node 22.18 ile varsayılan açıldı; testler .ts dosyalarını doğrudan çalıştırıyor.
  assert.equal(manifest.engines.node, ">=22.18.0");
  assert.match(manifest.scripts.test, /tests\/\*\.test\.ts/);
});

test("iç hata ayrıntısı istemciye sızmaz", async () => {
  const [errors, documents, overview, profiles, relations, processor] = await Promise.all([
    read("lib/errors.ts"),
    read("app/api/documents/route.ts"),
    read("app/api/overview/route.ts"),
    read("app/api/profiles/route.ts"),
    read("app/api/documents/[id]/relations/route.ts"),
    read("app/api/jobs/process/route.ts"),
  ]);
  assert.match(errors, /export class PublicError/);
  assert.match(errors, /logEvent\("error", "request\.failure"/);
  assert.match(errors, /correlationId: reference/);
  assert.match(errors, /Destek için olay kimliği/);
  // Genel catch blokları ham hata metni döndürmez.
  for (const [name, source] of [["documents", documents], ["overview", overview], ["profiles", profiles], ["relations", relations]]) {
    assert.match(source, /failure\(error,/, `${name}: failure() kullanılmıyor`);
    assert.doesNotMatch(source, /error instanceof Error \? error\.message/, `${name}: ham hata metni dönüyor`);
  }
  // OCR işletim hataları kullanıcıya açık, beklenmeyenler korelasyon kimliğiyle.
  assert.match(processor, /throw new PublicError\("OCR işine ait belge bulunamadı\."/);
  assert.match(processor, /isPublicError\(error\)/);
  assert.match(processor, /failure\(error, "ocr\.process"/);
  // Ayrıntı yine de işe kaydedilir (imza bindings alır: dead-letter alarmı
  // olayın kaynağında atılır, bkz. releaseFailedJob içindeki gerekçe).
  assert.match(processor, /releaseFailedJob\(bindings, job, detail\)/);
});

test("varlık doğrulama mesajları kullanıcıya açık kalır", async () => {
  const entities = await read("lib/entities.ts");
  assert.match(entities, /throw new PublicError\("Ada ve parsel değeri zorunludur\."\)/);
  assert.match(entities, /throw new PublicError\("Adres için en az mahalle/);
});
