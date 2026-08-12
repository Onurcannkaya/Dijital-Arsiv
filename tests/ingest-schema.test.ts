import assert from "node:assert/strict";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function insertSession(db: ReturnType<typeof createSqliteD1>, id: string, key: string) {
  db.raw.prepare(`INSERT INTO upload_sessions
    (id, user_id, unit, original_name, requested_document_type, idempotency_key, expected_byte_size, declared_media_type, expires_at)
    VALUES (?, 'user@sivas.bel.tr', 'Yazı İşleri', 'ornek.pdf', 'EVRAK', ?, 1024, 'application/pdf', '2026-08-01T00:00:00Z')`)
    .run(id, key);
}

test("F1.2 tabloları taze şemada kurulur", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    for (const table of [
      "upload_sessions", "upload_parts", "ingest_objects", "ingest_receipts",
      "upload_session_events", "integrity_runs", "integrity_findings",
      "reconciliation_runs", "reconciliation_findings", "access_tickets",
      "promotion_jobs", "promotion_receipts",
    ]) {
      assert.ok(names.has(table), `${table} kurulmadı`);
    }
  } finally {
    db.close();
  }
});

test("idempotency anahtarı ve parça numarası veritabanında tekildir", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    insertSession(db, "s1", "request-1");
    assert.throws(() => insertSession(db, "s2", "request-1"));

    db.raw.prepare(`INSERT INTO upload_parts
      (id, upload_session_id, part_number, byte_size, checksum_sha256, provider_part_token)
      VALUES ('p1', 's1', 1, 512, ?, 'etag-1')`).run(SHA_A);
    assert.throws(() => db.raw.prepare(`INSERT INTO upload_parts
      (id, upload_session_id, part_number, byte_size, checksum_sha256, provider_part_token)
      VALUES ('p2', 's1', 1, 512, ?, 'etag-2')`).run(SHA_B));
  } finally {
    db.close();
  }
});

test("durum değişikliği ardışık, olaylı ve sürümlü olmak zorundadır", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    insertSession(db, "s1", "request-1");

    // Olay kaydı olmadan ve zinciri atlayarak güncelleme reddedilir.
    assert.throws(() => db.raw.prepare(
      "UPDATE upload_sessions SET status = 'UPLOADING', state_version = 1 WHERE id = 's1'",
    ).run());
    db.raw.prepare(`INSERT INTO upload_session_events
      (id, upload_session_id, event_number, from_status, to_status, actor_kind, actor_id, event_hash)
      VALUES ('e1', 's1', 1, 'CREATED', 'UPLOADING', 'user', 'user@sivas.bel.tr', ?)`).run(SHA_A);
    db.raw.prepare(
      "UPDATE upload_sessions SET status = 'UPLOADING', state_version = 1 WHERE id = 's1'",
    ).run();
    assert.throws(() => db.raw.prepare(
      "UPDATE upload_sessions SET status = 'ACCEPTED', state_version = 2 WHERE id = 's1'",
    ).run());

    // Denetim olayları değiştirilemez ve silinemez.
    assert.throws(() => db.raw.prepare("UPDATE upload_session_events SET actor_id = 'x' WHERE id = 'e1'").run());
    assert.throws(() => db.raw.prepare("DELETE FROM upload_session_events WHERE id = 'e1'").run());
  } finally {
    db.close();
  }
});

test("FAILED -> PROMOTING geçişi temiz VERIFIED alındısı ve karantina nesnesi ister", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    insertSession(db, "s1", "request-1");
    db.raw.prepare(`INSERT INTO upload_session_events
      (id, upload_session_id, event_number, from_status, to_status, actor_kind, actor_id, event_hash)
      VALUES ('e1', 's1', 1, 'CREATED', 'UPLOADING', 'user', 'user@sivas.bel.tr', ?)`).run(SHA_A);
    db.raw.prepare("UPDATE upload_sessions SET status = 'UPLOADING', state_version = 1 WHERE id = 's1'").run();
    db.raw.prepare(`INSERT INTO upload_session_events
      (id, upload_session_id, event_number, from_status, to_status, actor_kind, actor_id, event_hash)
      VALUES ('e2', 's1', 2, 'UPLOADING', 'FAILED', 'service', 'ingest-worker', ?)`).run(SHA_B);
    db.raw.prepare("UPDATE upload_sessions SET status = 'FAILED', state_version = 2 WHERE id = 's1'").run();

    assert.throws(() => db.raw.prepare(`INSERT INTO upload_session_events
      (id, upload_session_id, event_number, from_status, to_status, actor_kind, actor_id, reason, event_hash)
      VALUES ('e3-missing', 's1', 3, 'FAILED', 'PROMOTING', 'operator', 'op@sivas.bel.tr', 'yeniden dene', ?)`).run(SHA_C));

    db.raw.prepare(`INSERT INTO ingest_objects
      (id, upload_session_id, object_class, object_key, storage_provider, bucket_or_namespace, media_type, byte_size, sha256)
      VALUES ('q1', 's1', 'quarantine', 'quarantine/s1', 'r2', 'QUARANTINE', 'application/pdf', 1024, ?)`).run(SHA_A);
    db.raw.prepare(`INSERT INTO ingest_receipts
      (id, upload_session_id, result, sha256, byte_size, declared_media_type, detected_media_type,
       type_validation_result, parser_name, parser_version, parser_result, scanner_engine, scanner_version, scanner_signature_version, scanner_result, verified_at)
      VALUES ('r1', 's1', 'VERIFIED', ?, 1024, 'application/pdf', 'application/pdf',
        'MATCH', 'qpdf', '12.2', 'VALID', 'clamav', '1.4', 'daily-1', 'CLEAN', CURRENT_TIMESTAMP)`).run(SHA_A);

    assert.throws(() => db.raw.prepare(`INSERT INTO upload_session_events
      (id, upload_session_id, event_number, from_status, to_status, actor_kind, actor_id, reason, ingest_receipt_id, event_hash)
      VALUES ('e3-user', 's1', 3, 'FAILED', 'PROMOTING', 'user', 'user@sivas.bel.tr', 'yeniden dene', 'r1', ?)`).run(SHA_B));

    db.raw.prepare(`INSERT INTO upload_session_events
      (id, upload_session_id, event_number, from_status, to_status, actor_kind, actor_id, reason, ingest_receipt_id, event_hash)
      VALUES ('e3', 's1', 3, 'FAILED', 'PROMOTING', 'operator', 'op@sivas.bel.tr', 'sağlayıcı kesintisi', 'r1', ?)`).run(SHA_C);
    db.raw.prepare(
      "UPDATE upload_sessions SET status = 'PROMOTING', state_version = 3, operator_retry_reason = 'sağlayıcı kesintisi' WHERE id = 's1'",
    ).run();
  } finally {
    db.close();
  }
});

test("asıl SHA-256 tekilliği binary_objects üzerinde yarış kapısıdır", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    const document = (id: string, sha: string) => db.raw.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
      VALUES (?, ?, 'a.pdf', ?, 'application/pdf', 10, ?, 'a@b')`)
      .run(id, `ARS-${id}`, `originals/${id}`, sha);
    document("d1", SHA_A);
    document("d2", SHA_B);
    db.raw.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('o1', 'd1', 'original', 'vault/o1', 'application/pdf', 10, ?)`).run(SHA_C);
    assert.throws(() => db.raw.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('o2', 'd2', 'original', 'vault/o2', 'application/pdf', 10, ?)`).run(SHA_C));
  } finally {
    db.close();
  }
});

test("v14 migration replaces the v13 promotion transition guard", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    db.raw.exec("DROP TRIGGER upload_sessions_transition_guard");
    db.raw.exec(`CREATE TRIGGER upload_sessions_transition_guard
      BEFORE UPDATE OF status ON upload_sessions
      WHEN OLD.status = 'PROMOTING' AND NEW.status = 'DUPLICATE'
      BEGIN SELECT RAISE(ABORT, 'v13 blocker'); END`);
    db.raw.prepare("UPDATE schema_state SET version = 13 WHERE id = 'archive'").run();

    await applyArchiveMigrations(db);
    const trigger = db.raw.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'upload_sessions_transition_guard'`).get() as { sql: string };
    assert.match(trigger.sql, /NEW\.status IN \('ACCEPTED', 'DUPLICATE', 'FAILED'\)/);
    assert.doesNotMatch(trigger.sql, /v13 blocker/);
  } finally {
    db.close();
  }
});
