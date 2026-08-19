/**
 * OCR dead-letter yönetimi — liste ve kuyruğa geri alma.
 *
 * Kanıtlanan davranış:
 * - Uç `ocr.run` yetkisi ister; doğrulayıcı ne listeyi görür ne geri alabilir.
 * - Liste yalnız azami denemeyi tüketmiş işleri, müdürlük kapsamıyla gösterir.
 * - Geri alma işi kuyruğa döndürür (deneme bütçesi tazelenir), belgeyi
 *   `queued` durumuna alır ve son hatayı taşıyan bir `ocr.requeued` denetim
 *   olayı yazar — "neden düşmüştü" sorusunun izi kaybolmaz.
 * - Kimlik listesi kapsamı yalnız daraltır; ikinci geri alma boş döner.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const ADMIN = "yonetici@sivas.bel.tr";
const REVIEWER = "dogrulayici@sivas.bel.tr";
const MANAGER = "sorumlu@sivas.bel.tr";
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const OTHER_UNIT = "Zabıta Müdürlüğü";
const ADMIN_JSON = { "oai-authenticated-user-email": ADMIN, "content-type": "application/json" };

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/dead-letter",
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
      VALUES (?, 'Doğrulayıcı', 'reviewer', ?, 1), (?, 'Sorumlu', 'archive_manager', ?, 1)`)
      .bind(REVIEWER, UNIT, MANAGER, UNIT).run();
    await run(server);
  } finally {
    await server.close();
  }
}

function hex64(key: string) {
  return key.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "d").padEnd(64, "d");
}

/** Azami denemeyi tüketmiş OCR işiyle birlikte `ocr_failed` belge kurar. */
async function seedDeadLetter(server: NodeServer, options: { key: string; unit: string }) {
  const id = `belge-${options.key}`;
  const at = "2026-08-18T09:00:00.000Z";
  await server.db.prepare(`INSERT INTO archive_documents (id, reference_no, original_name, storage_key,
      media_type, byte_size, sha256, document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'application/pdf', 2048, ?, 'Tasnif bekliyor', ?, 'ocr_failed', 'memur@sivas.bel.tr', ?, ?)`)
    .bind(id, `ARS-2026-${options.key.toUpperCase()}`, `${options.key}.pdf`,
      `originals/${id}/nesne-${options.key}`, hex64(options.key), options.unit, at, at).run();
  await server.db.prepare(`INSERT INTO processing_jobs (id, document_id, kind, status, attempt,
      max_attempts, model, error_message, dead_lettered_at, created_at, updated_at)
    VALUES (?, ?, 'ocr', 'failed', 3, 3, 'paddleocr-local', 'OCR servisi 500 hatası verdi: motor çöktü', ?, ?, ?)`)
    .bind(`is-${options.key}`, id, at, at, at).run();
  return { id, jobId: `is-${options.key}` };
}

test("dead-letter listesi ve geri alma ocr.run yetkisi ister", async () => {
  await withServer(async (server) => {
    const headers = { "oai-authenticated-user-email": REVIEWER };
    assert.equal((await fetch(`${server.url}/api/jobs/dead-letter`, { headers })).status, 403);
    assert.equal((await fetch(`${server.url}/api/jobs/dead-letter`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
    })).status, 403);
  });
});

test("liste müdürlük kapsamıyla süzülür ve son hatayı taşır", async () => {
  await withServer(async (server) => {
    const inScope = await seedDeadLetter(server, { key: "e1", unit: UNIT });
    await seedDeadLetter(server, { key: "e2", unit: OTHER_UNIT });

    const response = await fetch(`${server.url}/api/jobs/dead-letter`, {
      headers: { "oai-authenticated-user-email": MANAGER },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { jobs: Array<{ documentId: string; errorMessage: string }> };
    assert.deepEqual(payload.jobs.map((job) => job.documentId), [inScope.id],
      "kapsam dışı müdürlüğün arızası listelenmemeli");
    assert.match(payload.jobs[0].errorMessage, /motor çöktü/);

    // Yönetici (kapsam '*') ikisini de görür.
    const all = await fetch(`${server.url}/api/jobs/dead-letter`, {
      headers: { "oai-authenticated-user-email": ADMIN },
    });
    assert.equal(((await all.json()) as { jobs: unknown[] }).jobs.length, 2);
  });
});

test("geri alma işi kuyruğa döndürür, belgeyi açar ve denetim izi bırakır", async () => {
  await withServer(async (server) => {
    const target = await seedDeadLetter(server, { key: "e3", unit: UNIT });
    const untouched = await seedDeadLetter(server, { key: "e4", unit: UNIT });

    const response = await fetch(`${server.url}/api/jobs/dead-letter`, {
      method: "POST", headers: ADMIN_JSON,
      body: JSON.stringify({ documentIds: [target.id] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { requeued: 1 });

    const job = await server.db.prepare(`SELECT status, attempt, dead_lettered_at, error_message
      FROM processing_jobs WHERE id = ?`).bind(target.jobId)
      .first<{ status: string; attempt: number; dead_lettered_at: string | null; error_message: string | null }>();
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempt, 0, "deneme bütçesi tazelenmeli");
    assert.equal(job?.dead_lettered_at, null);

    const document = await server.db.prepare("SELECT status FROM archive_documents WHERE id = ?")
      .bind(target.id).first<{ status: string }>();
    assert.equal(document?.status, "queued");

    // Son hata denetim olayına taşınır; iş kaydından silinse de iz kaybolmaz.
    const audit = await server.db.prepare(`SELECT action, actor, details_json FROM audit_events
      WHERE document_id = ? ORDER BY event_number DESC LIMIT 1`).bind(target.id)
      .first<{ action: string; actor: string; details_json: string }>();
    assert.equal(audit?.action, "ocr.requeued");
    assert.equal(audit?.actor, ADMIN);
    assert.match(audit?.details_json ?? "", /motor çöktü/);

    // Kimlik listesi kapsamı daraltır: diğer arıza yerinde durur.
    const other = await server.db.prepare("SELECT status FROM processing_jobs WHERE id = ?")
      .bind(untouched.jobId).first<{ status: string }>();
    assert.equal(other?.status, "failed");

    // Toplu geri alma kalanı süpürür; ikinci çağrı boş döner.
    const sweep = await fetch(`${server.url}/api/jobs/dead-letter`, { method: "POST", headers: ADMIN_JSON, body: "{}" });
    assert.deepEqual(await sweep.json(), { requeued: 1 });
    const empty = await fetch(`${server.url}/api/jobs/dead-letter`, { method: "POST", headers: ADMIN_JSON, body: "{}" });
    assert.deepEqual(await empty.json(), { requeued: 0 });
  });
});
