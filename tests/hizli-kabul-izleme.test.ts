/**
 * Hızlı kabul sihirbazının izleme sözleşmesi.
 *
 * Sihirbaz, yüklediği oturumların akıbetini `GET /api/uploads?ids=` ile izler
 * ve terfi tamamlanınca oturumu belge kimliğine bağlar. Kanıtlanan davranış:
 * - `ids` sorgusu KABUL EDİLENLER dahil yalnız kullanıcının KENDİ oturumlarını
 *   döndürür; başka kullanıcının oturum kimliği sonuçtan düşer (sızıntı yok);
 * - kabul edilen oturumda `documentId`, terfi defterinden (promotion_jobs)
 *   gelir — sihirbaz "dosyam hangi belge oldu" sorusunu böyle yanıtlar;
 * - tek istekte 40 oturum tavanı vardır;
 * - sihirbazın kendisi kaynak düzeyinde denetlenir: çoklu dosya girişi,
 *   dört adım, sıralı yükleme iptal bekçesi ve advance yoklaması — bu
 *   denetimler f13 yüzey testinin (ortak zincir) tamamlayıcısıdır.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "yonetici@sivas.bel.tr";
const CLERK = "memur@sivas.bel.tr";
const UNIT = "İmar ve Şehircilik Müdürlüğü";

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/hizli-kabul-izleme",
        ARCHIVE_ADMIN_EMAILS: ADMIN,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    await server.db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES (?, 'Memur', 'archive_manager', ?, 1)`).bind(CLERK, UNIT).run();
    await run(server);
  } finally {
    await server.close();
  }
}

async function seedSession(server: NodeServer, options: { key: string; user: string; status: string }) {
  const id = `oturum-${options.key}`;
  await server.db.prepare(`INSERT INTO upload_sessions (id, user_id, unit, original_name,
      requested_document_type, idempotency_key, status, state_version, expected_byte_size,
      declared_media_type, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Tasnif bekliyor', ?, ?, 0, 2048, 'application/pdf',
      '2026-08-21T09:00:00.000Z', '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`)
    .bind(id, options.user, UNIT, `${options.key}.pdf`, `idem-${options.key}`, options.status).run();
  return id;
}

test("ids sorgusu kabul edilenler dahil yalnız kendi oturumlarını belge kimliğiyle döndürür", async () => {
  await withServer(async (server) => {
    const accepted = await seedSession(server, { key: "i1", user: ADMIN, status: "ACCEPTED" });
    const scanning = await seedSession(server, { key: "i2", user: ADMIN, status: "SCANNING" });
    const foreign = await seedSession(server, { key: "i3", user: CLERK, status: "SCANNING" });
    // Terfi defteri: kabul edilen oturumun belge kimliği buradan okunur.
    await server.db.prepare(`INSERT INTO ingest_receipts (id, upload_session_id, result, sha256,
        byte_size, declared_media_type, detected_media_type, type_validation_result, parser_name,
        parser_version, parser_result, scanner_engine, scanner_version, scanner_signature_version,
        scanner_result, created_at)
      VALUES ('alindi-i1', ?, 'VERIFIED', ?, 2048, 'application/pdf', 'application/pdf', 'MATCH',
        'qpdf', '1', 'VALID', 'clamav', '1', '1', 'CLEAN', '2026-08-20T09:01:00.000Z')`)
      .bind(accepted, "a".repeat(64)).run();
    await server.db.prepare(`INSERT INTO promotion_jobs (id, upload_session_id, ingest_receipt_id,
        document_id, binary_object_id, target_object_key, sha256, status, attempt, max_attempts,
        created_at, updated_at)
      VALUES ('is-i1', ?, 'alindi-i1', 'belge-i1', 'nesne-i1', 'originals/belge-i1/nesne-i1', ?,
        'COMPLETED', 1, 5, '2026-08-20T09:02:00.000Z', '2026-08-20T09:02:00.000Z')`)
      .bind(accepted, "a".repeat(64)).run();

    const response = await fetch(
      `${server.url}/api/uploads?ids=${encodeURIComponent([accepted, scanning, foreign].join(","))}`,
      { headers: { "oai-authenticated-user-email": ADMIN } },
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as { sessions: Array<{ id: string; status: string; documentId: string | null }> };
    const byId = new Map(payload.sessions.map((row) => [row.id, row]));
    assert.equal(payload.sessions.length, 2, "başka kullanıcının oturumu sonuçtan düşmeli");
    assert.ok(!byId.has(foreign));
    assert.equal(byId.get(accepted)?.status, "ACCEPTED");
    assert.equal(byId.get(accepted)?.documentId, "belge-i1", "belge kimliği terfi defterinden gelmeli");
    assert.equal(byId.get(scanning)?.documentId, null);
  });
});

test("ids sorgusunda 40 oturum tavanı vardır", async () => {
  await withServer(async (server) => {
    const ids = Array.from({ length: 41 }, (_, index) => `oturum-x${index}`).join(",");
    const response = await fetch(`${server.url}/api/uploads?ids=${ids}`, {
      headers: { "oai-authenticated-user-email": ADMIN },
    });
    assert.equal(response.status, 400);
  });
});

test("sihirbaz kaynak denetimi: çoklu dosya, dört adım, iptal bekçesi ve advance yoklaması", async () => {
  const source = await readFile(new URL("../app/archive/upload-dialog.tsx", import.meta.url), "utf8");
  // Çoklu dosya girişi ve sürükle-bırakta bütün dosyaların alınması.
  assert.match(source, /type="file" multiple/);
  assert.match(source, /event\.dataTransfer\.files\b/);
  assert.doesNotMatch(source, /dataTransfer\.files\.item\(0\)/, "sürükle-bırak tek dosyaya düşmemeli");
  // Dört adımlı sihirbaz ve adım başlıkları.
  for (const step of ["Belgeler", "Yükleme ve okuma", "Kontrol", "Özet"]) {
    assert.ok(source.includes(`"${step}"`), `sihirbaz adımı eksik: ${step}`);
  }
  // Dosyalar sırayla yüklenir ve pencere kapatılırsa kuyruk arayüzsüz sürmez.
  assert.match(source, /batchCancelledRef/);
  // Kabul hattı cron beklemeden sihirbaz yoklamasıyla ilerletilir.
  assert.match(source, /\/api\/pipeline\/advance/);
  // Yoklama, oturum akıbetini ids sorgusuyla izler.
  assert.match(source, /\/api\/uploads\?ids=/);
});
