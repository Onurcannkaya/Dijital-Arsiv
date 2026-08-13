import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("archive workspace includes the core municipal workflow", async () => {
  const source = await readFile(new URL("../app/archive/workspace.tsx", import.meta.url), "utf8");
  assert.match(source, /Genel Bakış/);
  assert.match(source, /Gelen Evrak/);
  assert.match(source, /Doğrulama/);
  assert.match(source, /Dijital Arşiv/);
});

test("arayüz uydurma belge ve sabit gösterge değeri içermez", async () => {
  const source = await readFile(new URL("../app/archive/workspace.tsx", import.meta.url), "utf8");
  // Kurgusal belgeler ve kişi adları kayıt yönetim ekranında bulunmamalıdır.
  assert.doesNotMatch(source, /seedDocs/);
  assert.doesNotMatch(source, /YILMAZ/);
  assert.doesNotMatch(source, /Ahmet/);
  // Sabit metrikler, depolama kotası ve yedekleme zamanı kaldırıldı.
  assert.doesNotMatch(source, /128\.430/);
  assert.doesNotMatch(source, /2,8 TB/);
  assert.doesNotMatch(source, /03:15/);
  assert.doesNotMatch(source, /Tümü çalışıyor/);
  assert.doesNotMatch(source, /16 Temmuz 2026/);
  // Sayımlar gerçek uçtan gelir ve ölçülmeyenler açıkça bildirilir.
  assert.match(source, /\/api\/overview/);
  assert.match(source, /Henüz ölçülmüyor/);
  assert.match(source, /kapasite kotası tanımlı değil/);
});

test("PWA shell and design tokens are present", async () => {
  const [manifest, css, serviceWorker] = await Promise.all([
    readFile(new URL("../app/manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/archive/archive.css", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(manifest, /Sivas Arşiv/);
  assert.match(css, /--ar-sidebar/);
  assert.match(css, /@media\(max-width:800px\)/);
  assert.match(serviceWorker, /sivas-arsiv-shell-v2/);
});

test("service worker belge içeriğini önbelleğe almaz", async () => {
  const serviceWorker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  // Önceki sürüm her GET yanıtını saklıyordu; belge baytları diskte kalıyordu.
  assert.match(serviceWorker, /isCacheableShellRequest/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /response\.type === "basic"/);
  // Önbellek adı yükseltildi: eski önbellekte kalmış belge yanıtları silinir.
  assert.doesNotMatch(serviceWorker, /shell-v1/);
});
test("resumable upload pipeline isolates untrusted bytes in quarantine", async () => {
  const [route, parts, complete, ingest, storage, schema, config] = await Promise.all([
    readFile(new URL("../app/api/uploads/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/uploads/[id]/parts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/uploads/[id]/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ingest-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/archive-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assert.match(route, /createUploadSession/);
  assert.match(parts, /x-content-sha256/);
  assert.match(complete, /completeUploadSession/);
  assert.match(ingest, /MULTIPART_THRESHOLD_BYTES/);
  assert.match(ingest, /quarantineKey/);
  assert.match(ingest, /dependencies\.hasher\.sha256/);
  assert.doesNotMatch(route + parts + complete, /ARCHIVE_FILES\.(?:put|get|delete)/);
  assert.match(storage, /getIngestStorages/);
  assert.match(schema, /uploadSessions/);
  assert.match(config, /TEMPORARY_FILES/);
  assert.match(config, /QUARANTINE_FILES/);
});
test("OCR evidence pipeline persists coordinates and opens the real document", async () => {
  const [processor, detailRoute, contract, review, migration] = await Promise.all([
    readFile(new URL("../app/api/jobs/process/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ocr-contract.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/archive/document-review.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_same_morgan_stark.sql", import.meta.url), "utf8"),
  ]);
  assert.match(processor, /\/v1\/ocr/);
  assert.match(processor, /INSERT INTO ocr_pages/);
  assert.match(processor, /INSERT INTO extracted_fields/);
  assert.match(processor, /status = 'failed'/);
  // Zorunlu alan kuralı merkezî alan politikasından gelir (ADR-008).
  assert.match(processor, /requiredFields\(profile\)/);
  assert.match(processor, /MISSING_VALUE/);
  assert.match(detailRoute, /fileUrl/);
  assert.match(contract, /parseOcrServiceResult/);
  assert.match(review, /evidence-box/);
  assert.match(review, /DocumentReview/);
  assert.match(migration, /CREATE TABLE `ocr_pages`/);
  assert.match(migration, /CREATE TABLE `extracted_fields`/);
});
test("personnel confirmation archives through a tamper-evident audit chain", async () => {
  const [fieldRoute, approveRoute, auditHelper, detail, migration] = await Promise.all([
    readFile(new URL("../app/api/documents/[id]/fields/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/approve/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/audit.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/archive/document-review.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_elite_zodiak.sql", import.meta.url), "utf8"),
  ]);
  assert.match(fieldRoute, /fields\.confirmed/);
  // Tek değer varsayımının yerini değer bazlı doğrulama durumu aldı.
  assert.match(fieldRoute, /verification_status = 'CONFIRMED'/);
  assert.match(approveRoute, /document\.archived/);
  assert.match(approveRoute, /status = 'archived'/);
  assert.match(auditHelper, /previousHash/);
  assert.match(auditHelper, /SHA-256/);
  // Ekran değişmez kaydı gösterir. Karma değeri personel düzeninde kapalıdır
  // (design.md §4.3), yerine ZİNCİRİ DOĞRULANMIŞ bütünlük ifadesi durur —
  // ifadenin körü körüne yazılmadığı da burada tutulur.
  assert.match(detail, /Değiştirilemez işlem kaydı/);
  assert.match(detail, /chainBroken=auditChain\.some/);
  assert.match(detail, /zinciri kopuksuz/);
  assert.match(detail, /zinciri kopuk; işletim ekibine bildirin/);
  assert.match(detail, /Alanları onayla/);
  assert.match(migration, /audit_events_no_update/);
  assert.match(migration, /audit_events_no_delete/);
});
test("server-side roles and unit scopes protect every archive operation", async () => {
  const [authorization, uploads, detail, fileRoute, fields, approve, process, me, workspace, migration, storage] = await Promise.all([
    readFile(new URL("../lib/authorization.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/uploads/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/file/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/fields/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/approve/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jobs/process/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/me/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/archive/workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_pale_wallflower.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/archive-storage.ts", import.meta.url), "utf8"),
  ]);
  assert.match(authorization, /oai-authenticated-user-email/);
  assert.match(authorization, /archive_manager/);
  assert.match(authorization, /canAccessUnit/);
  assert.match(uploads, /document\.upload/);
  assert.match(detail, /document\.read/);
  assert.match(fileRoute, /document\.read/);
  assert.match(fields, /document\.review/);
  assert.match(fields, /Belgeyi müdürlük kapsamınızın dışına taşıyamazsınız/);
  assert.match(approve, /document\.archive/);
  assert.match(process, /ocr\.run/);
  assert.match(me, /roleLabel/);
  assert.match(workspace, /\/api\/me/);
  assert.match(migration, /CHECK \(`role` IN/);
  assert.doesNotMatch(storage, /requestActor/);
});
test("cleaned OCR text is searchable and reviewable", async () => {
  const [cleaner, processor, documents, detail, review, migration] = await Promise.all([
    readFile(new URL("../services/ocr/app/text_cleaner.py", import.meta.url), "utf8"),
    readFile(new URL("../app/api/jobs/process/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/archive/document-review.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_fair_gravity.sql", import.meta.url), "utf8"),
  ]);
  assert.match(cleaner, /readable_text/);
  // Aranabilir biçim artık yalnız `lib/text-search.ts` içinde üretilir.
  assert.doesNotMatch(cleaner, /^def search_text/m);
  assert.match(processor, /page\.rawText/);
  assert.match(processor, /normalizeSearch\(page\.fullText\)/);
  assert.match(documents, /parameters\.get\("q"\)/);
  assert.match(documents, /p\.search_text LIKE/);
  assert.match(detail, /searchText:page\.search_text/);
  assert.match(review, /Okunabilir metin/);
  assert.match(review, /Onaylı ve aranabilir belge metni/);
  assert.match(migration, /ADD `raw_text`/);
  assert.match(migration, /ADD `search_text`/);
});
test("personnel-approved full text is versioned and required for archival", async () => {
  const [textRoute, detailRoute, approveRoute, review, schema, migration] = await Promise.all([
    readFile(new URL("../app/api/documents/[id]/text/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/documents/[id]/approve/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/archive/document-review.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_marvelous_bruce_banner.sql", import.meta.url), "utf8"),
  ]);
  assert.match(textRoute, /document\.review/);
  assert.match(textRoute, /INSERT INTO text_revisions/);
  assert.match(textRoute, /text\.corrected/);
  assert.match(textRoute, /text\.confirmed/);
  assert.match(textRoute, /prepareAuditEvent/);
  assert.match(detailRoute, /confirmedText:page\.confirmed_text/);
  assert.match(approveRoute, /confirmed_text IS NULL/);
  assert.match(review, /Onaylı ve aranabilir belge metni/);
  assert.match(review, /Metni onayla/);
  assert.match(schema, /textRevisions/);
  assert.match(migration, /CREATE TABLE `text_revisions`/);
  assert.match(migration, /ADD `confirmed_text`/);
});
