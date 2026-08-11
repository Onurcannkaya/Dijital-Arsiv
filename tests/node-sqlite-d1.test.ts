/**
 * Kurum içi port P2 — üretim sınıfı SQLite D1 sarmalayıcısı testleri.
 *
 * Kanıt hedefi: gerçek arşiv şeması (göçler + değişmezlik tetikleyicileri) ve
 * durum makinesi, hiçbir SQL değişikliği olmadan kurum içi sarmalayıcı üzerinde
 * çalışır; D1 `batch` sözleşmesinin tek-işlem atomikliği korunur; veri kapanış
 * sonrası kalıcıdır ve WAL modu etkindir.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { transitionIngestSession } from "../lib/ingest-events.ts";
import { createNodeSqliteD1 } from "../lib/node-sqlite-d1.ts";

const SESSION_SQL = `INSERT INTO upload_sessions
  (id, user_id, unit, original_name, requested_document_type, idempotency_key,
   status, expected_byte_size, declared_media_type, expires_at)
  VALUES (?, 'port@sivas.bel.tr', 'Kabul Testleri', 'ornek.pdf', 'Tasnif bekliyor',
   ?, 'CREATED', 128, 'application/pdf', '2026-09-01T00:00:00.000Z')`;

test("gerçek şema göçleri ve durum makinesi üretim sarmalayıcısında çalışır", async () => {
  const db = createNodeSqliteD1({ path: ":memory:" });
  try {
    await applyArchiveMigrations(db);
    await db.prepare(SESSION_SQL).bind("port-session-1", "port-idem-1").run();
    await transitionIngestSession(db, {
      sessionId: "port-session-1",
      to: "UPLOADING",
      actor: { kind: "user", id: "port@sivas.bel.tr" },
      now: "2026-08-11T10:00:00.000Z",
      eventId: "port-event-1",
    });
    const session = await db.prepare("SELECT status, state_version FROM upload_sessions WHERE id = ?")
      .bind("port-session-1").first<{ status: string; state_version: number }>();
    assert.equal(session?.status, "UPLOADING");
    assert.equal(session?.state_version, 1);

    // Değişmezlik tetikleyicisi: denetim olayı güncellenemez.
    await assert.rejects(() => db
      .prepare("UPDATE upload_session_events SET event_hash = ? WHERE upload_session_id = ?")
      .bind("f".repeat(64), "port-session-1").run());
  } finally {
    db.close();
  }
});

test("batch tek işlemdir: başarısız ifade öncekileri de geri alır", async () => {
  const db = createNodeSqliteD1({ path: ":memory:" });
  try {
    await applyArchiveMigrations(db);
    await db.prepare(SESSION_SQL).bind("port-session-2", "port-idem-2").run();
    await assert.rejects(() => db.batch([
      db.prepare(SESSION_SQL).bind("port-session-3", "port-idem-3"),
      // Aynı birincil anahtar: ikinci ifade kısıt ihlaliyle düşer.
      db.prepare(SESSION_SQL).bind("port-session-2", "port-idem-4"),
    ]));
    const survivor = await db.prepare("SELECT id FROM upload_sessions WHERE id = ?")
      .bind("port-session-3").first();
    assert.equal(survivor, null, "geri alınan işlem iz bırakmamalı");
  } finally {
    db.close();
  }
});

test("batch ifade başına meta.changes döndürür", async () => {
  const db = createNodeSqliteD1({ path: ":memory:" });
  try {
    await db.prepare("CREATE TABLE port_counts (id TEXT PRIMARY KEY, value INTEGER)").run();
    const results = await db.batch([
      db.prepare("INSERT INTO port_counts (id, value) VALUES (?, ?)").bind("a", 1),
      db.prepare("UPDATE port_counts SET value = 2 WHERE id = ?").bind("yok"),
      db.prepare("INSERT OR IGNORE INTO port_counts (id, value) VALUES (?, ?)").bind("a", 3),
    ]);
    assert.deepEqual(results.map((result) => result.meta.changes), [1, 0, 0]);
  } finally {
    db.close();
  }
});

test("veri kapanış sonrası kalıcıdır ve dosya modunda WAL etkindir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "port-sqlite-"));
  const path = join(dir, "veri", "arsiv.db");
  try {
    const first = createNodeSqliteD1({ path });
    const mode = await first.prepare("PRAGMA journal_mode").first<{ journal_mode: string }>();
    assert.equal(mode?.journal_mode, "wal");
    const sync = await first.prepare("PRAGMA synchronous").first<{ synchronous: number }>();
    assert.equal(sync?.synchronous, 2, "synchronous=FULL beklenir");
    await applyArchiveMigrations(first);
    await first.prepare(SESSION_SQL).bind("port-session-4", "port-idem-5").run();
    first.close();

    const second = createNodeSqliteD1({ path });
    try {
      const row = await second.prepare("SELECT unit FROM upload_sessions WHERE id = ?")
        .bind("port-session-4").first<{ unit: string }>();
      assert.equal(row?.unit, "Kabul Testleri");
    } finally {
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("boolean 0/1'e çevrilir; tanımsız bağlama değeri açık hatadır", async () => {
  const db = createNodeSqliteD1({ path: ":memory:" });
  try {
    await db.prepare("CREATE TABLE port_flags (id TEXT PRIMARY KEY, active INTEGER)").run();
    await db.prepare("INSERT INTO port_flags (id, active) VALUES (?, ?)").bind("x", true).run();
    const row = await db.prepare("SELECT active FROM port_flags WHERE id = ?")
      .bind("x").first<{ active: number }>();
    assert.equal(row?.active, 1);
    assert.throws(
      () => db.prepare("INSERT INTO port_flags (id, active) VALUES (?, ?)").bind("y", undefined),
      /tanımsız olamaz/,
    );
  } finally {
    db.close();
  }
});

test("yabancı anahtar kısıtları etkindir", async () => {
  const db = createNodeSqliteD1({ path: ":memory:" });
  try {
    await applyArchiveMigrations(db);
    await assert.rejects(() => db.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('orphan', 'olmayan-belge', 'original', 'k', 'application/pdf', 1, ?)`)
      .bind("a".repeat(64)).run());
  } finally {
    db.close();
  }
});
