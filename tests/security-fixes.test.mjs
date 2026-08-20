import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("e-posta karşılaştırması locale bağımsızdır", async () => {
  const authorization = await read("lib/authorization.ts");
  // `tr` locale küçültmesi `"I"` harfini `"ı"` yapar ve kimliği bozar.
  assert.doesNotMatch(authorization, /toLocaleLowerCase\("tr"\)/);
  assert.match(authorization, /export function normalizeEmail/);
  assert.match(authorization, /value\.trim\(\)\.toLowerCase\(\)/);
});

test("kabul nesne anahtarı ve nesne metadatası kişisel veri taşımaz", async () => {
  const [ingest, route] = await Promise.all([
    read("lib/ingest-service.ts"),
    read("app/api/documents/route.ts"),
  ]);
  assert.match(ingest, /`temporary\/\$\{sessionId\}\/payload`/);
  assert.match(ingest, /`quarantine\/\$\{sessionId\}\/payload`/);
  assert.match(ingest, /customMetadata: \{ uploadSessionId: .* objectClass: "temporary" \}/);
  assert.match(ingest, /customMetadata: \{ uploadSessionId: .* objectClass: "quarantine" \}/);
  assert.doesNotMatch(ingest, /customMetadata: \{[^\n]*(?:originalName|requestedDocumentType|userId)/);
  assert.doesNotMatch(route, /legacyDirectUpload|objectStorage\.put|request\.formData\(\)/);
});
test("OCR servisi anahtarsız çalışmaz", async () => {
  const [main, readme] = await Promise.all([read("services/ocr/app/main.py"), read("services/ocr/README.md")]);
  assert.match(main, /if not token:/);
  assert.match(main, /OCR_SERVICE_TOKEN tanımlı değil/);
  assert.match(main, /status_code=503/);
  // Eski davranış: anahtar tanımsızsa uç tamamen açıktı.
  assert.doesNotMatch(main, /if token and authorization/);
  assert.match(readme, /zorunludur/);
});

test("görüntüleme ve indirme ayrı yetkilidir ve denetlenir", async () => {
  const [fileRoute, ticketRoute, authorization, audit] = await Promise.all([
    read("app/api/documents/[id]/file/route.ts"),
    read("app/api/documents/[id]/access-ticket/route.ts"),
    read("lib/authorization.ts"),
    read("lib/audit.ts"),
  ]);
  assert.match(authorization, /"document\.download"/);
  // Görüntüleyici rolü indirme yetkisi almaz.
  assert.match(authorization, /viewer: \["document\.read"\]/);
  // F1.9: yetki ayrımı bilet üretiminde uygulanır; dosya rotası bilet/oturum ister.
  assert.match(ticketRoute, /scope === "DOWNLOAD" \? "document\.download" : "document\.read"/);
  assert.match(fileRoute, /isDownload \? "document\.download" : "document\.read"/);
  assert.match(fileRoute, /CREDENTIAL_REQUIRED/);
  assert.match(fileRoute, /authorization/);
  assert.match(fileRoute, /URL_CREDENTIAL_REJECTED/);
  assert.doesNotMatch(fileRoute, /searchParams\.get\("ticket"\)/);
  assert.match(fileRoute, /document\.access-denied/);
  assert.match(fileRoute, /document\.downloaded/);
  assert.match(fileRoute, /document\.viewed/);
  // Denetim kaydı yazılamazsa dosya sunulmaz.
  assert.match(fileRoute, /Erişim denetim kaydı oluşturulamadı; dosya sunulmadı/);
  assert.match(fileRoute, /"cache-control": "no-store, private"/);
  // Zincir sıralı olduğu için eşzamanlı erişimde yeniden denenir.
  assert.match(audit, /export async function writeAuditEvent/);
  assert.match(audit, /attempts = 4/);
});

test("kabul oturumu, OCR, doğrulama ve erişim olayları denetim zincirine girer", async () => {
  const [ingest, events, processor, fields, relations, approve, textRoute, fileRoute] = await Promise.all([
    read("lib/ingest-service.ts"),
    read("lib/ingest-events.ts"),
    read("app/api/jobs/process/route.ts"),
    read("app/api/documents/[id]/fields/route.ts"),
    read("app/api/documents/[id]/relations/route.ts"),
    read("app/api/documents/[id]/approve/route.ts"),
    read("app/api/documents/[id]/text/route.ts"),
    read("app/api/documents/[id]/file/route.ts"),
  ]);
  assert.match(ingest, /transitionIngestSession/);
  assert.match(events, /canonicalEvent/);
  assert.match(events, /previousHash/);
  const actions = [
    [processor, "ocr.completed"], [fields, "fields.confirmed"],
    [relations, "relation.verified"], [approve, "document.archived"], [textRoute, "text.confirmed"],
    [fileRoute, "document.viewed"],
  ];
  for (const [source, action] of actions) {
    assert.ok(source.includes(action), `${action} olayı yazılmıyor`);
  }
});
test("arama normalleştirmesi tek uygulamadır", async () => {
  const [cleaner, main, contract, processor, schema] = await Promise.all([
    read("services/ocr/app/text_cleaner.py"),
    read("services/ocr/app/main.py"),
    read("lib/ocr-contract.ts"),
    read("app/api/jobs/process/route.ts"),
    read("lib/archive-schema.ts"),
  ]);
  // Python tarafında ikinci bir uygulama kalmadı.
  assert.doesNotMatch(cleaner, /^def search_text/m);
  assert.doesNotMatch(main, /searchText/);
  assert.doesNotMatch(contract, /searchText/);
  // Dizin uygulama katmanında üretilir.
  assert.match(processor, /normalizeSearch\(page\.fullText\)/);
  // Mevcut satırlar tek uygulamayla yenilenir, yoksa eski belgeler aranamaz olur.
  // Yenileme artık kuyruğa alınan, kaldığı yerden devam eden bakım işidir.
  assert.match(schema, /async function enqueueSearchReindex/);
  assert.match(schema, /version: 6, run: enqueueSearchReindex/);
  assert.match(schema, /export async function runMaintenanceSlice/);
});

test("Türkçe locale ile bozulmuş e-posta kayıtları onarılır", async () => {
  const schema = await read("lib/archive-schema.ts");
  assert.match(schema, /async function repairTurkishLoweredEmails/);
  assert.match(schema, /version: 5, run: repairTurkishLoweredEmails/);
  assert.match(schema, /replaceAll\("ı", "i"\)\.replaceAll\("İ", "i"\)/);
});

test("genel bakış sayıları gerçek sorgudan gelir ve kapsamla süzülür", async () => {
  const overview = await read("app/api/overview/route.ts");
  assert.match(overview, /document\.read/);
  assert.match(overview, /FROM archive_documents WHERE \(\? = '\*' OR unit = \?\)/);
  assert.match(overview, /FROM processing_jobs/);
  assert.match(overview, /FROM binary_objects/);
  // Ölçülmeyen gösterge kalmadı: servis sağlığını /api/health, yedeği
  // backup_runs defteri, kota kullanımını storage.quota ölçer. `unmeasured`
  // listesi bu yüzden kalktı; uydurma tavan da üretilmez (configured:false).
  assert.match(overview, /readStorageQuota/);
  assert.match(overview, /readBackupSummary/);
  // Alan olarak dönmemeli; deseni anlatan yorum satırı serbesttir.
  assert.doesNotMatch(overview, /unmeasured:/);
});
