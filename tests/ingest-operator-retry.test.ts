/**
 * ADR-013 operatör kurtarma komutu — FAILED → PROMOTING.
 *
 * Alan kuralı, olay zinciri ve veritabanı bekçileri baştan beri vardı; bu
 * testler sözleşmenin ÇAĞIRICISINI (rota + operatör görünümü) kanıtlar:
 * - kurtarma ayrı yetki ister (`ingest.retry`); doğrulayıcı rolü çalıştıramaz;
 * - gerekçesiz kurtarma reddedilir; gerekçe olay zincirine ve
 *   `operator_retry_reason` kolonuna yazılır;
 * - deneme penceresi (ADR-014: 7 gün) kapandıysa komut reddedilir;
 * - karantina kaydı silinmişse komut reddedilir;
 * - FAILED olmayan oturum (ikinci tıklama dahil) reddedilir;
 * - terfi işi kuyruğa tazelenmiş döner (attempt sıfırlanır) ki işçi yeniden alsın;
 * - `scope=failed` görünümü kurtarma yetkisi ister ve retryable bayrağını söyler.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { transitionIngestSession } = await import("../lib/ingest-events.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "yonetici@sivas.bel.tr";
const REVIEWER = "dogrulayici@sivas.bel.tr";
const CLERK = "memur@sivas.bel.tr";
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const ADMIN_JSON = { "oai-authenticated-user-email": ADMIN, "content-type": "application/json" };

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/ingest-retry",
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
      VALUES (?, 'Doğrulayıcı', 'reviewer', ?, 1)`).bind(REVIEWER, UNIT).run();
    await run(server);
  } finally {
    await server.close();
  }
}

/**
 * Oturumu gerçek geçiş servisiyle FAILED durumuna yürütür; kanıt kayıtlarını
 * (karantina nesnesi, VERIFIED alındısı, FAILED terfi işi) defterlere yazar.
 * Zaman parametresi pencere testleri içindir: bütün olaylar o ana damgalanır.
 */
async function seedFailedSession(server: NodeServer, options: { key: string; at: string }) {
  const db = server.db;
  const id = `oturum-${options.key}`;
  const receiptId = `alindi-${options.key}`;
  const sha = options.key.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "a").padEnd(64, "a");
  await db.prepare(`INSERT INTO upload_sessions (id, user_id, unit, original_name,
      requested_document_type, idempotency_key, status, state_version, expected_byte_size,
      declared_media_type, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Tasnif bekliyor', ?, 'CREATED', 0, 2048, 'application/pdf', ?, ?, ?)`)
    .bind(id, CLERK, UNIT, `cilt-${options.key}.pdf`, `idem-${options.key}`, options.at, options.at, options.at).run();
  await db.prepare(`INSERT INTO ingest_objects (id, upload_session_id, object_class, object_key,
      storage_provider, bucket_or_namespace, media_type, byte_size, sha256, created_at)
    VALUES (?, ?, 'quarantine', ?, 'r2', 'QUARANTINE_FILES', 'application/pdf', 2048, ?, ?)`)
    .bind(`karantina-${options.key}`, id, `quarantine/${options.key}`, sha, options.at).run();
  await db.prepare(`INSERT INTO ingest_receipts (id, upload_session_id, result, sha256, byte_size,
      declared_media_type, detected_media_type, type_validation_result, parser_name, parser_version,
      parser_result, scanner_engine, scanner_version, scanner_signature_version, scanner_result, created_at)
    VALUES (?, ?, 'VERIFIED', ?, 2048, 'application/pdf', 'application/pdf', 'MATCH', 'qpdf', '1',
      'VALID', 'clamav', '1', '1', 'CLEAN', ?)`)
    .bind(receiptId, id, sha, options.at).run();
  await db.prepare(`INSERT INTO promotion_jobs (id, upload_session_id, ingest_receipt_id, document_id,
      binary_object_id, target_object_key, sha256, status, attempt, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', 5, 5, ?, ?)`)
    .bind(`is-${options.key}`, id, receiptId, `belge-${options.key}`, `nesne-${options.key}`,
      `originals/belge-${options.key}/nesne-${options.key}`, sha, options.at, options.at).run();
  const walk = ["UPLOADING", "QUARANTINED", "SCANNING", "VERIFIED", "PROMOTING", "FAILED"] as const;
  for (const to of walk) {
    await transitionIngestSession(db, {
      sessionId: id,
      to,
      actor: { kind: "service", id: "test-hatti" },
      ingestReceiptId: to === "FAILED" ? receiptId : undefined,
      failureCode: to === "FAILED" ? "VAULT_VERIFICATION_FAILED" : undefined,
      reason: to === "FAILED" ? "yazma sonrası doğrulama başarısız" : undefined,
      now: options.at,
    });
  }
  return { id, receiptId, jobId: `is-${options.key}` };
}

test("kurtarma komutu FAILED oturumu terfiye geri alır ve izini bırakır", async () => {
  await withServer(async (server) => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { id, jobId } = await seedFailedSession(server, { key: "b1", at: recent });

    const response = await fetch(`${server.url}/api/uploads/${id}/retry`, {
      method: "POST", headers: ADMIN_JSON,
      body: JSON.stringify({ reason: "Depolama arızası giderildi; kasa yeniden yazılabilir." }),
    });
    const payload = await response.json() as { session?: { status: string } };
    assert.equal(response.status, 200);
    // Rota bir terfi turunu hemen dener; fiziksel nesne test deposunda olmadığı
    // için tur başarısız kalır ama oturum PROMOTING'te, iş kuyruğunda durur.
    assert.equal(payload.session?.status, "PROMOTING");

    const session = await server.db.prepare(`SELECT status, operator_retry_reason
      FROM upload_sessions WHERE id = ?`).bind(id).first<{ status: string; operator_retry_reason: string }>();
    assert.equal(session?.status, "PROMOTING");
    assert.match(session?.operator_retry_reason ?? "", /Depolama arızası/);

    const event = await server.db.prepare(`SELECT from_status, to_status, actor_kind, actor_id, reason
      FROM upload_session_events WHERE upload_session_id = ? AND to_status = 'PROMOTING'
      ORDER BY event_number DESC LIMIT 1`).bind(id)
      .first<{ from_status: string; actor_kind: string; actor_id: string; reason: string }>();
    assert.equal(event?.from_status, "FAILED");
    assert.equal(event?.actor_kind, "operator");
    assert.equal(event?.actor_id, ADMIN);
    assert.match(event?.reason ?? "", /Depolama arızası/);

    // İş tazelendi: FAILED değil ve deneme bütçesi yeniden açık.
    const job = await server.db.prepare(`SELECT status, attempt, max_attempts FROM promotion_jobs WHERE id = ?`)
      .bind(jobId).first<{ status: string; attempt: number; max_attempts: number }>();
    assert.notEqual(job?.status, "FAILED");
    assert.ok((job?.attempt ?? 99) < (job?.max_attempts ?? 0), "deneme bütçesi tazelenmedi");

    // İkinci tıklama: oturum artık FAILED değil; komut körlemesine tekrarlanamaz.
    const again = await fetch(`${server.url}/api/uploads/${id}/retry`, {
      method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ reason: "tekrar" }),
    });
    assert.equal(again.status, 409);
  });
});

test("gerekçesiz kurtarma reddedilir", async () => {
  await withServer(async (server) => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { id } = await seedFailedSession(server, { key: "b2", at: recent });
    const response = await fetch(`${server.url}/api/uploads/${id}/retry`, {
      method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ reason: "  " }),
    });
    assert.equal(response.status, 400);
    const session = await server.db.prepare("SELECT status FROM upload_sessions WHERE id = ?")
      .bind(id).first<{ status: string }>();
    assert.equal(session?.status, "FAILED");
  });
});

test("kurtarma ayrı yetki ister; doğrulayıcı çalıştıramaz", async () => {
  await withServer(async (server) => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { id } = await seedFailedSession(server, { key: "b3", at: recent });
    const response = await fetch(`${server.url}/api/uploads/${id}/retry`, {
      method: "POST",
      headers: { "oai-authenticated-user-email": REVIEWER, "content-type": "application/json" },
      body: JSON.stringify({ reason: "yetkisiz deneme" }),
    });
    assert.equal(response.status, 403);
  });
});

test("deneme penceresi kapandıysa kurtarma reddedilir (ADR-014: 7 gün)", async () => {
  await withServer(async (server) => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { id } = await seedFailedSession(server, { key: "b4", at: old });
    const response = await fetch(`${server.url}/api/uploads/${id}/retry`, {
      method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ reason: "geç kalınmış deneme" }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error ?? "", /pencere/i);
  });
});

test("karantina kaydı silinmişse kurtarılacak kaynak yoktur", async () => {
  await withServer(async (server) => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { id } = await seedFailedSession(server, { key: "b5", at: recent });
    await server.db.prepare(`UPDATE ingest_objects SET deleted_at = ? WHERE upload_session_id = ?`)
      .bind(new Date().toISOString(), id).run();
    const response = await fetch(`${server.url}/api/uploads/${id}/retry`, {
      method: "POST", headers: ADMIN_JSON, body: JSON.stringify({ reason: "nesnesiz deneme" }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error ?? "", /[Kk]arantina/);
  });
});

test("scope=failed görünümü kurtarma yetkisi ister ve ön koşulları söyler", async () => {
  await withServer(async (server) => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = await seedFailedSession(server, { key: "b6", at: recent });
    const stale = await seedFailedSession(server, { key: "b7", at: old });

    const forbidden = await fetch(`${server.url}/api/uploads?scope=failed`, {
      headers: { "oai-authenticated-user-email": REVIEWER },
    });
    assert.equal(forbidden.status, 403);

    const response = await fetch(`${server.url}/api/uploads?scope=failed`, {
      headers: { "oai-authenticated-user-email": ADMIN },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { sessions: Array<{ id: string; retryable: boolean; uploadedBy: string }> };
    const byId = new Map(payload.sessions.map((row) => [row.id, row]));
    assert.equal(byId.get(fresh.id)?.retryable, true, "taze arıza kurtarılabilir görünmeli");
    assert.equal(byId.get(stale.id)?.retryable, false, "penceresi kapanmış arıza kurtarılabilir görünmemeli");
    assert.equal(byId.get(fresh.id)?.uploadedBy, CLERK);
  });
});
