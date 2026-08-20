/**
 * ADR-017 yedekleme dilimleri ve alarm taşıyıcısı.
 *
 * Kanıtlanan davranış:
 * - Yedek hedefi yapılandırılmamışsa dilim dürüstçe atlar ve genel bakış
 *   `configured:false` bildirir; uydurma "son yedek" zamanı dönmez.
 * - Artımlı asıl kopyası gerçek nesneyi ikinci ad alanına yazar, imleci
 *   defterde taşır ve sonraki koşuda yalnız YENİ nesneyi kopyalar.
 * - Günlük üst veri dökümü bütün tabloları tek kesimde çıkarır; günlük
 *   manifest nesne kimlik+SHA envanterini taşır ve sağlayıcı anahtarını
 *   İÇERMEZ (ADR-017: anahtar taşınabilir bütünlük kanıtı değildir).
 * - Aynı gün içinde ikinci tur "idle" döner: dilim kendi hızını defterden alır.
 * - Alarm taşıyıcısı yapılandırılmış uca JSON POST eder; uç yoksa "unrouted",
 *   uç hata verirse "failed" döner ve hiçbir durumda fırlatmaz.
 * - Cron dikişi alarm ve yedek dilimini gerçekten çağırır (kaynak denetimi).
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { createNodeSqliteD1 } = await import("../lib/node-sqlite-d1.ts");
const { applyArchiveMigrations, ARCHIVE_SCHEMA_VERSION } = await import("../lib/archive-schema.ts");
const { createLocalFsNamespace } = await import("../lib/local-fs-object-storage.ts");
const { runBackupSlice, readBackupSummary, INCREMENTAL_BATCH } = await import("../lib/backup.ts");
const { dispatchAlert } = await import("../lib/alerts.ts");
const { storageReader, storageStaging } = await import("../lib/storage-roles.ts");

const STORE = `.wrangler/tmp/backup-test-${process.pid}`;

async function makeBindings() {
  const db = createNodeSqliteD1({ path: ":memory:" });
  await applyArchiveMigrations(db);
  const archive = createLocalFsNamespace(`${STORE}/asil`);
  const backup = createLocalFsNamespace(`${STORE}/yedek-${crypto.randomUUID()}`);
  return { DB: db, ARCHIVE_FILES: archive, BACKUP_FILES: backup, APP_ENV: "test" };
}

/** Kasada gerçek baytlarıyla duran bir asıl nesne + defter kaydı kurar. */
async function seedOriginal(bindings: Awaited<ReturnType<typeof makeBindings>>, key: string, createdAt: string) {
  const content = `asil-icerik-${key}`;
  const bytes = new TextEncoder().encode(content);
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  const documentId = `belge-${key}`;
  const objectKey = `originals/${documentId}/nesne-${key}`;
  await bindings.DB.prepare(`INSERT INTO archive_documents (id, reference_no, original_name, storage_key,
      media_type, byte_size, sha256, document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, 'Tasnif bekliyor', 'Belirlenmedi', 'queued', 'memur@sivas.bel.tr', ?, ?)`)
    .bind(documentId, `ARS-2026-${key.toUpperCase()}`, `${key}.pdf`, objectKey, bytes.byteLength, sha, createdAt, createdAt).run();
  await bindings.DB.prepare(`INSERT INTO binary_objects (id, document_id, object_class, object_key,
      storage_provider, bucket_or_namespace, media_type, byte_size, sha256, encryption_status, generator, created_at)
    VALUES (?, ?, 'original', ?, 's3', 'ARCHIVE_FILES', 'application/pdf', ?, ?, 'provider-managed', 'test', ?)`)
    .bind(`nesne-${key}`, documentId, objectKey, bytes.byteLength, sha, createdAt).run();
  await storageStaging(bindings.ARCHIVE_FILES).put(objectKey, content, {
    contentType: "application/pdf", contentSha256Hex: sha,
  });
  return { objectKey, sha };
}

test("yedek hedefi yapılandırılmamışsa dilim atlar ve özet configured:false döner", async () => {
  const bindings = await makeBindings();
  const bare = { DB: bindings.DB, ARCHIVE_FILES: bindings.ARCHIVE_FILES, APP_ENV: "test" };
  const slice = await runBackupSlice(bare);
  assert.deepEqual(slice, { skipped: true, reason: "unconfigured" });
  assert.deepEqual(await readBackupSummary(bare), { configured: false });
});

test("dilimler sırayla koşar: artımlı kopya, günlük döküm, günlük manifest, sonra idle", async () => {
  const bindings = await makeBindings();
  const seeded = await seedOriginal(bindings, "y1", "2026-08-19T08:00:00.000Z");
  const now = new Date("2026-08-19T09:00:00.000Z");

  // 1. tur: artımlı kopya (RPO'su en sıkı iş önce).
  const first = await runBackupSlice(bindings, { now });
  assert.equal(first.skipped, false);
  assert.equal((first as { kind: string }).kind, "originals_incremental");
  const copied = await storageReader(bindings.BACKUP_FILES).head(seeded.objectKey);
  assert.ok(copied, "asıl nesne yedek ad alanına kopyalanmalı");
  const incrementalRun = await bindings.DB.prepare(`SELECT status, copied_count, cursor FROM backup_runs
    WHERE kind = 'originals_incremental' ORDER BY created_at DESC LIMIT 1`)
    .first<{ status: string; copied_count: number; cursor: string }>();
  assert.equal(incrementalRun?.status, "COMPLETED");
  assert.equal(incrementalRun?.copied_count, 1);
  assert.match(incrementalRun?.cursor ?? "", /nesne-y1/);

  // 2. tur: artımlının saati dolmadı, sıra günlük üst veri dökümünde.
  const second = await runBackupSlice(bindings, { now });
  assert.equal((second as { kind: string }).kind, "metadata_export");
  const exportRun = await bindings.DB.prepare(`SELECT object_key, sha256, byte_size FROM backup_runs
    WHERE kind = 'metadata_export' AND status = 'COMPLETED'`)
    .first<{ object_key: string; sha256: string; byte_size: number }>();
  assert.ok(exportRun?.object_key?.startsWith("metadata/2026-08-19/"));
  assert.match(exportRun?.sha256 ?? "", /^[a-f0-9]{64}$/);
  const exported = await storageReader(bindings.BACKUP_FILES).get(exportRun!.object_key);
  assert.ok(exported);
  const exportBody = JSON.parse(new TextDecoder().decode(await new Response(exported!.body).arrayBuffer())) as {
    schemaVersion: number; tables: Record<string, Array<Record<string, unknown>>> };
  assert.equal(exportBody.schemaVersion, ARCHIVE_SCHEMA_VERSION);
  assert.equal(exportBody.tables.archive_documents?.length, 1, "üst veri dökümü belge kaydını taşımalı");
  assert.ok(exportBody.tables.backup_runs, "döküm yedek defterini de kapsar");

  // 3. tur: günlük manifest.
  const third = await runBackupSlice(bindings, { now });
  assert.equal((third as { kind: string }).kind, "manifest_daily");
  const manifestRun = await bindings.DB.prepare(`SELECT object_key FROM backup_runs
    WHERE kind = 'manifest_daily' AND status = 'COMPLETED'`).first<{ object_key: string }>();
  const manifest = await storageReader(bindings.BACKUP_FILES).get(manifestRun!.object_key);
  const manifestBody = JSON.parse(new TextDecoder().decode(await new Response(manifest!.body).arrayBuffer())) as {
    totals: { objects: number }; objects: Array<Record<string, unknown>> };
  assert.equal(manifestBody.totals.objects, 1);
  assert.equal(manifestBody.objects[0].sha256, seeded.sha);
  // ADR-017: sağlayıcı anahtarı taşınabilir kanıt değildir; manifeste girmez.
  assert.ok(!("objectKey" in manifestBody.objects[0]) && !("object_key" in manifestBody.objects[0]));

  // 4. tur: ilk manifest üretildiği için İLK tutarlılık kontrolü hemen koşar
  // (sonrakiler aylıktır); 5. tur boş döner.
  const fourth = await runBackupSlice(bindings, { now });
  assert.equal((fourth as { kind: string }).kind, "consistency_check");
  const fifth = await runBackupSlice(bindings, { now });
  assert.deepEqual(fifth, { skipped: true, reason: "idle" });

  const summary = await readBackupSummary(bindings);
  assert.equal(summary.configured, true);
  assert.ok(summary.configured && summary.lastIncrementalAt && summary.lastMetadataExportAt && summary.lastManifestAt);
});

test("artımlı kopya imleçten sürer: sonraki saat yalnız yeni nesneyi kopyalar", async () => {
  const bindings = await makeBindings();
  await seedOriginal(bindings, "y2", "2026-08-19T08:00:00.000Z");
  await runBackupSlice(bindings, { now: new Date("2026-08-19T09:00:00.000Z") });

  const fresh = await seedOriginal(bindings, "y3", "2026-08-19T09:30:00.000Z");
  const next = await runBackupSlice(bindings, { now: new Date("2026-08-19T10:00:01.000Z") });
  assert.equal((next as { kind: string }).kind, "originals_incremental");
  const run = await bindings.DB.prepare(`SELECT copied_count, cursor FROM backup_runs
    WHERE kind = 'originals_incremental' ORDER BY created_at DESC LIMIT 1`)
    .first<{ copied_count: number; cursor: string }>();
  assert.equal(run?.copied_count, 1, "yalnız imleçten sonraki nesne kopyalanmalı");
  assert.match(run?.cursor ?? "", /nesne-y3/);
  assert.ok(await storageReader(bindings.BACKUP_FILES).head(fresh.objectKey));
  assert.ok(INCREMENTAL_BATCH > 1, "dilim üst sınırı birden büyük olmalı");
});

test("alarm taşıyıcısı: teslim, kanalsızlık ve uç arızası ayrı sonuçlardır ve hiçbiri fırlatmaz", async () => {
  const received: Array<Record<string, unknown>> = [];
  let respondWith = 200;
  const stub = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(respondWith);
      response.end();
    });
  });
  await new Promise<void>((resolve) => { stub.listen(0, "127.0.0.1", () => resolve()); });
  const url = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  try {
    const delivered = await dispatchAlert({ ALARM_WEBHOOK_URL: url, ALARM_WEBHOOK_TOKEN: "sir", APP_ENV: "test" }, {
      severity: "critical", event: "integrity.finding", title: "Test bulgusu", detail: { adet: 2 },
    });
    assert.equal(delivered, "delivered");
    assert.equal(received.length, 1);
    assert.equal(received[0].event, "integrity.finding");
    assert.equal(received[0].severity, "critical");
    assert.equal((received[0].detail as { adet: number }).adet, 2);

    const unrouted = await dispatchAlert({ APP_ENV: "test" }, {
      severity: "warning", event: "backup.failed", title: "Kanalsız uyarı",
    });
    assert.equal(unrouted, "unrouted");

    respondWith = 500;
    const failed = await dispatchAlert({ ALARM_WEBHOOK_URL: url, APP_ENV: "test" }, {
      severity: "critical", event: "ocr.dead-letter", title: "Uç arızalı",
    });
    assert.equal(failed, "failed");
  } finally {
    await new Promise<void>((resolve) => { stub.close(() => resolve()); });
  }
});

test("cron dikişi yedek dilimini ve alarmları gerçekten çağırır", async () => {
  const source = await readFile(new URL("../lib/scheduled-jobs.ts", import.meta.url), "utf8");
  assert.match(source, /runBackupSlice\(bindings\)/);
  assert.match(source, /event: "integrity\.finding"/);
  /*
   * Dead-letter alarmı cron turunda DEĞİL, olayın kaynağında atılır
   * (releaseFailedJob): sihirbaz yoklaması ya da elle tetiklemeyle düşen iş
   * de alarmsız kalmaz. Cron'da ikinci bir kopyası olmamalı — çift alarm.
   */
  assert.doesNotMatch(source, /ocr\.dead-letter/);
  const jobs = await readFile(new URL("../app/api/jobs/process/route.ts", import.meta.url), "utf8");
  assert.match(jobs, /event: "ocr\.dead-letter"/);
  assert.match(jobs, /status === "failed"/);
});
