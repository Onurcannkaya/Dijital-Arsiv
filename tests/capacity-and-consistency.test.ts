/**
 * Kapasite kotası ve aylık yedek tutarlılık kontrolü.
 *
 * Kanıtlanan davranış:
 * - Kota tavanı tanımlı değilse kullanım yine ölçülür ama configured:false
 *   döner; genel bakış uydurma tavan/oran göstermez.
 * - Eşik aşımı alarma bağlanır ve aynı eşik için günde bir kez gider —
 *   "bir kez"in kanıtı capacity_alerts defteridir; kritik eşik uyarıyı gölgeler.
 * - Aylık tutarlılık kontrolü yedekten GERİ OKUR: döküm/manifest özetini
 *   yeniden hesaplar, imleç gerisindeki asılları yedekte arar; uyuşmazlıkta
 *   koşu FAILED kalır ve alarm gider. İlk manifest üretilmeden koşmaz.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { createNodeSqliteD1 } = await import("../lib/node-sqlite-d1.ts");
const { applyArchiveMigrations } = await import("../lib/archive-schema.ts");
const { createLocalFsNamespace } = await import("../lib/local-fs-object-storage.ts");
const { runBackupSlice } = await import("../lib/backup.ts");
const { readStorageQuota, runQuotaCheck } = await import("../lib/capacity.ts");
const { storageStaging } = await import("../lib/storage-roles.ts");
const { startNodeServer } = await import("../server/app.ts");

const STORE = `.wrangler/tmp/capacity-test-${process.pid}`;
const ADMIN = "yonetici@sivas.bel.tr";

async function makeBindings(extra: Record<string, string> = {}) {
  const db = createNodeSqliteD1({ path: ":memory:" });
  await applyArchiveMigrations(db);
  return {
    DB: db,
    ARCHIVE_FILES: createLocalFsNamespace(`${STORE}/asil-${crypto.randomUUID()}`),
    BACKUP_FILES: createLocalFsNamespace(`${STORE}/yedek-${crypto.randomUUID()}`),
    APP_ENV: "test",
    ...extra,
  };
}

/** Kasada gerçek baytlarıyla duran bir asıl nesne + defter kaydı kurar. */
async function seedOriginal(bindings: Awaited<ReturnType<typeof makeBindings>>, key: string, createdAt: string, byteSize?: number) {
  const content = `asil-icerik-${key}`;
  const bytes = new TextEncoder().encode(content);
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  const documentId = `belge-${key}`;
  const objectKey = `originals/${documentId}/nesne-${key}`;
  const size = byteSize ?? bytes.byteLength;
  await bindings.DB.prepare(`INSERT INTO archive_documents (id, reference_no, original_name, storage_key,
      media_type, byte_size, sha256, document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, 'Tasnif bekliyor', 'Belirlenmedi', 'queued', 'memur@sivas.bel.tr', ?, ?)`)
    .bind(documentId, `ARS-2026-${key.toUpperCase()}`, `${key}.pdf`, objectKey, size, sha, createdAt, createdAt).run();
  await bindings.DB.prepare(`INSERT INTO binary_objects (id, document_id, object_class, object_key,
      storage_provider, bucket_or_namespace, media_type, byte_size, sha256, encryption_status, generator, created_at)
    VALUES (?, ?, 'original', ?, 's3', 'ARCHIVE_FILES', 'application/pdf', ?, ?, 'provider-managed', 'test', ?)`)
    .bind(`nesne-${key}`, documentId, objectKey, size, sha, createdAt).run();
  await storageStaging(bindings.ARCHIVE_FILES).put(objectKey, content, {
    contentType: "application/pdf", contentSha256Hex: sha,
  });
  return { objectKey, sha };
}

function startAlertStub(): Promise<{ url: string; hits: () => Array<Record<string, unknown>>; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const received: Array<Record<string, unknown>> = [];
    const stub = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { received.push(JSON.parse(body) as Record<string, unknown>); response.writeHead(200); response.end(); });
    });
    stub.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
      hits: () => received,
      close: () => new Promise((done) => { stub.close(() => done()); }),
    }));
  });
}

test("kota tavanı tanımsızken kullanım ölçülür, tavan uydurulmaz", async () => {
  const bindings = await makeBindings();
  await seedOriginal(bindings, "k0", "2026-08-19T08:00:00.000Z", 4096);
  const quota = await readStorageQuota(bindings);
  assert.deepEqual(quota, { configured: false, usedBytes: 4096 });
  assert.deepEqual(await runQuotaCheck(bindings), { skipped: true, reason: "unconfigured" });
});

test("eşik aşımı günde bir kez alarma gider; kritik eşik uyarıyı gölgeler", async () => {
  const stub = await startAlertStub();
  try {
    // 1 GB tavan; 0,85 GB kullanım → %80 uyarı eşiği aşılmış.
    const bindings = await makeBindings({ ARCHIVE_STORAGE_QUOTA_GB: "1", ALARM_WEBHOOK_URL: stub.url });
    await seedOriginal(bindings, "k1", "2026-08-19T08:00:00.000Z", Math.round(0.85 * 1024 ** 3));
    const now = new Date("2026-08-20T09:00:00.000Z");

    const first = await runQuotaCheck(bindings, { now });
    assert.equal(first.skipped, false);
    assert.equal((first as { thresholdPercent: number }).thresholdPercent, 80);
    assert.equal(stub.hits().length, 1);
    assert.equal(stub.hits()[0].severity, "warning");

    // Aynı gün ikinci kontrol: alarm tekrarlanmaz.
    const repeat = await runQuotaCheck(bindings, { now: new Date("2026-08-20T15:00:00.000Z") });
    assert.deepEqual(repeat, { skipped: true, reason: "already-alerted" });
    assert.equal(stub.hits().length, 1);

    // Kullanım kritik eşiğe tırmanır: FARKLI eşik, yeni alarm; tek alarm gider.
    await seedOriginal(bindings, "k2", "2026-08-20T10:00:00.000Z", Math.round(0.12 * 1024 ** 3));
    const critical = await runQuotaCheck(bindings, { now: new Date("2026-08-20T16:00:00.000Z") });
    assert.equal((critical as { thresholdPercent: number }).thresholdPercent, 95);
    assert.equal(stub.hits().length, 2);
    assert.equal(stub.hits()[1].severity, "critical");

    // Ertesi gün eşik hâlâ aşıksa hatırlatma gider.
    const nextDay = await runQuotaCheck(bindings, { now: new Date("2026-08-21T16:00:01.000Z") });
    assert.equal(nextDay.skipped, false);
    assert.equal(stub.hits().length, 3);
  } finally {
    await stub.close();
  }
});

test("genel bakış kota bloğunu döndürür (uçtan uca)", async () => {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: `${STORE}/e2e`,
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        APP_ENV: "staging",
        ARCHIVE_STORAGE_QUOTA_GB: "2",
      },
    },
    host: "127.0.0.1", port: 0, scheduler: false,
  });
  try {
    const response = await fetch(`${server.url}/api/overview`, {
      headers: { "oai-authenticated-user-email": ADMIN },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      storage: { quota: { configured: boolean; limitBytes: number; usedBytes: number } };
      unmeasured?: unknown;
    };
    assert.equal(payload.storage.quota.configured, true);
    assert.equal(payload.storage.quota.limitBytes, 2 * 1024 ** 3);
    assert.equal(payload.storage.quota.usedBytes, 0);
    assert.equal(payload.unmeasured, undefined, "ölçülmeyen gösterge kalmadı; liste kalktı");
  } finally {
    await server.close();
  }
});

test("aylık tutarlılık kontrolü yedeği geri okur; bozulmayı yakalar ve alarm verir", async () => {
  const stub = await startAlertStub();
  try {
    const bindings = await makeBindings({ ALARM_WEBHOOK_URL: stub.url });
    await seedOriginal(bindings, "t1", "2026-08-19T08:00:00.000Z");

    // Gün 0: artımlı + döküm + manifest üretilir; İLK tutarlılık kontrolü ilk
    // manifestin hemen ardından koşar (yedeğin çalıştığı ilk günden kanıtlanır),
    // sonrakiler aylıktır.
    const t0 = new Date("2026-08-20T09:00:00.000Z");
    for (let step = 0; step < 3; step += 1) await runBackupSlice(bindings, { now: t0 });
    const firstCheck = await runBackupSlice(bindings, { now: t0 });
    assert.equal((firstCheck as { kind: string }).kind, "consistency_check");
    assert.deepEqual(await runBackupSlice(bindings, { now: t0 }), { skipped: true, reason: "idle" },
      "aynı gün ikinci tutarlılık koşusu olmamalı");

    // 31. gün: sırasıyla artımlı, döküm, manifest tazelenir; dördüncü dilim tutarlılıktır.
    const t31 = new Date("2026-09-20T09:30:00.000Z");
    for (let step = 0; step < 3; step += 1) await runBackupSlice(bindings, { now: t31 });
    const consistency = await runBackupSlice(bindings, { now: t31 });
    assert.equal(consistency.skipped, false);
    assert.equal((consistency as { kind: string }).kind, "consistency_check");
    const run = await bindings.DB.prepare(`SELECT status, copied_count FROM backup_runs
      WHERE kind = 'consistency_check' ORDER BY created_at DESC LIMIT 1`)
      .first<{ status: string; copied_count: number }>();
    assert.equal(run?.status, "COMPLETED");
    assert.ok((run?.copied_count ?? 0) >= 3, "döküm + manifest + asıl örneklemi denetlenmeli");

    // 62. gün: günlük işler tazelenir, ardından EN SON manifest kaydının özeti
    // bozulur (bit çürümesi / eksik yazım taklidi) — kontrol tam bu kaydı okur.
    const t62 = new Date("2026-10-21T09:30:00.000Z");
    for (let step = 0; step < 3; step += 1) await runBackupSlice(bindings, { now: t62 });
    await bindings.DB.prepare(`UPDATE backup_runs SET sha256 = ?
      WHERE id = (SELECT id FROM backup_runs WHERE kind = 'manifest_daily' AND status = 'COMPLETED'
        ORDER BY completed_at DESC LIMIT 1)`).bind("e".repeat(64)).run();
    const before = stub.hits().length;
    const failed = await runBackupSlice(bindings, { now: t62 });
    assert.deepEqual(failed, { skipped: true, reason: "idle" }, "arıza turu düşürmez; defter + alarm bırakır");
    const failedRun = await bindings.DB.prepare(`SELECT status, error FROM backup_runs
      WHERE kind = 'consistency_check' ORDER BY created_at DESC LIMIT 1`)
      .first<{ status: string; error: string | null }>();
    assert.equal(failedRun?.status, "FAILED");
    assert.match(failedRun?.error ?? "", /uyuşmazlık/);
    assert.ok(stub.hits().length > before, "tutarlılık arızası alarma bağlanmalı");
    assert.equal(stub.hits()[stub.hits().length - 1].event, "backup.failed");
  } finally {
    await stub.close();
  }
});

test("bakım turu kota kontrolünü gerçekten çağırır (kaynak denetimi)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../lib/scheduled-jobs.ts", import.meta.url), "utf8");
  assert.match(source, /runQuotaCheck\(bindings\)/);
});
