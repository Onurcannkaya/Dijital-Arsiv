import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import {
  IngestOperationError,
  MULTIPART_PART_BYTES,
  completeUploadSession,
  createUploadSession,
  expireIncompleteUploads,
  getUploadSession,
  uploadPart,
} from "../lib/ingest-service.ts";
import {
  MemoryNamespace,
  MemoryStagingStorage,
  createNodeStreamingHasher,
} from "./memory-object-storage.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fixture() {
  const db = createSqliteD1();
  let sequence = 0;
  let now = new Date("2026-07-30T10:00:00.000Z");
  const temporary = new MemoryStagingStorage(new MemoryNamespace());
  const quarantine = new MemoryStagingStorage(new MemoryNamespace());
  return {
    db,
    temporary,
    quarantine,
    dependencies: {
      db,
      temporary,
      quarantine,
      hasher: createNodeStreamingHasher(),
      randomId: () => `id-${++sequence}`,
      now: () => now,
    },
    setNow(value: string) { now = new Date(value); },
  };
}

test("idempotent oturum aynı yükleme kimliğini döndürür, farklı istekle çatışır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const input = {
      userId: "user@sivas.bel.tr",
      unit: "Yazı İşleri",
      idempotencyKey: "request-1",
      expectedByteSize: 1024,
      declaredMediaType: "application/pdf",
    };
    const first = await createUploadSession(target.dependencies, input);
    const second = await createUploadSession(target.dependencies, input);
    assert.equal(first.id, second.id);
    assert.equal(first.resumed, false);
    assert.equal(second.resumed, true);
    await assert.rejects(
      () => createUploadSession(target.dependencies, { ...input, expectedByteSize: 2048 }),
      (error: unknown) => error instanceof IngestOperationError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    target.db.close();
  }
});

test("yükleme kabulü fiziksel kullanım ve açık oturum rezervasyonunu atomik kotayla sınırlar", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const dependencies = { ...target.dependencies, capacityLimitBytes: 1500 };
    const input = {
      userId: "user@sivas.bel.tr",
      unit: "Yazı İşleri",
      idempotencyKey: "quota-1",
      expectedByteSize: 1000,
      declaredMediaType: "application/pdf",
    };
    const first = await createUploadSession(dependencies, input);
    const resumed = await createUploadSession(dependencies, input);
    assert.equal(resumed.id, first.id, "idempotent tekrar ikinci rezervasyon oluşturmamalı");

    await assert.rejects(() => createUploadSession(dependencies, {
      ...input,
      idempotencyKey: "quota-2",
      expectedByteSize: 501,
    }), (error: unknown) => error instanceof IngestOperationError
      && error.code === "STORAGE_QUOTA_EXCEEDED" && error.status === 507);
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM upload_sessions").get() as { count: number }).count, 1);
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM ingest_objects").get() as { count: number }).count, 1,
      "reddedilen rezervasyon sahipsiz envanter kaydı bırakmamalı");
  } finally {
    target.db.close();
  }
});

test("multipart kesintiden sonra eksik parçadan sürer ve karantinaya akışla tamamlanır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const total = MULTIPART_PART_BYTES * 2 + 1024;
    const created = await createUploadSession(target.dependencies, {
      userId: "user@sivas.bel.tr",
      unit: "Yazı İşleri",
      idempotencyKey: "large-1",
      expectedByteSize: total,
      declaredMediaType: "application/pdf",
    });
    const part1 = new Uint8Array(MULTIPART_PART_BYTES).fill(1);
    const part2 = new Uint8Array(MULTIPART_PART_BYTES).fill(2);
    const part3 = new Uint8Array(1024).fill(3);

    // İkinci parça önce gelir; durum sorgusu yalnız eksik parçaları bildirir.
    await uploadPart(target.dependencies, {
      sessionId: created.id, userId: "user@sivas.bel.tr", partNumber: 2,
      byteSize: part2.byteLength, checksumSha256: sha256(part2), body: stream(part2),
    });
    const interrupted = await getUploadSession(target.dependencies, created.id, "user@sivas.bel.tr");
    assert.deepEqual(interrupted.completedParts, [2]);
    assert.deepEqual(interrupted.missingParts, [1, 3]);

    await uploadPart(target.dependencies, {
      sessionId: created.id, userId: "user@sivas.bel.tr", partNumber: 1,
      byteSize: part1.byteLength, checksumSha256: sha256(part1), body: stream(part1),
    });
    await uploadPart(target.dependencies, {
      sessionId: created.id, userId: "user@sivas.bel.tr", partNumber: 3,
      byteSize: part3.byteLength, checksumSha256: sha256(part3), body: stream(part3),
    });
    const completed = await completeUploadSession(target.dependencies, created.id, "user@sivas.bel.tr");
    assert.equal(completed.status, "QUARANTINED");
    assert.equal(completed.missingParts.length, 0);
    assert.equal((await target.temporary.head(`temporary/${created.id}/payload`)), null);
    assert.equal((await target.quarantine.head(`quarantine/${created.id}/payload`))?.size, total);
    const inventory = target.db.raw.prepare(
      "SELECT object_class, sha256, deleted_at FROM ingest_objects WHERE upload_session_id = ? ORDER BY object_class",
    ).all(created.id) as Array<{ object_class: string; sha256: string | null; deleted_at: string | null }>;
    assert.equal(inventory.length, 2);
    assert.ok(inventory.find((row) => row.object_class === "temporary")?.deleted_at);
    assert.match(inventory.find((row) => row.object_class === "quarantine")?.sha256 ?? "", /^[a-f0-9]{64}$/);
  } finally {
    target.db.close();
  }
});

test("parça checksum ve dört eşzamanlı istek kapıları sunucu tarafında uygulanır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const created = await createUploadSession(target.dependencies, {
      userId: "user@sivas.bel.tr",
      unit: "Yazı İşleri",
      idempotencyKey: "small-1",
      expectedByteSize: 4,
      declaredMediaType: "application/pdf",
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await assert.rejects(() => uploadPart(target.dependencies, {
      sessionId: created.id, userId: "user@sivas.bel.tr", partNumber: 1,
      byteSize: 4, checksumSha256: "0".repeat(64), body: stream(bytes),
    }));
    // Kirası canlı dört ayrı istek yeni parçayı reddeder (fikstür saati 10:00'da sabittir).
    const seedLeases = (prefix: string, expiresAt: string) => {
      target.db.raw.prepare("DELETE FROM upload_part_leases WHERE upload_session_id = ?").run(created.id);
      const insert = target.db.raw.prepare(`INSERT INTO upload_part_leases
        (id, upload_session_id, part_number, expires_at) VALUES (?, ?, ?, ?)`);
      for (let part = 1; part <= 4; part += 1) insert.run(`${prefix}-${part}`, created.id, part, expiresAt);
    };
    const liveLease = "2026-07-30T10:10:00.000Z";
    seedLeases("live", liveLease);
    await assert.rejects(
      () => uploadPart(target.dependencies, {
        sessionId: created.id, userId: "user@sivas.bel.tr", partNumber: 1,
        byteSize: 4, checksumSha256: sha256(bytes), body: stream(bytes),
      }),
      (error: unknown) => error instanceof IngestOperationError && error.code === "PART_CONCURRENCY_LIMIT",
    );

    // Çökme sızıntısı senaryosu: süresi dolan istek kiraları temizlenir, oturum kilitlenmez.
    const staleLease = "2026-07-30T09:59:00.000Z";
    seedLeases("stale", staleLease);
    const recovered = await uploadPart(target.dependencies, {
      sessionId: created.id, userId: "user@sivas.bel.tr", partNumber: 1,
      byteSize: 4, checksumSha256: sha256(bytes), body: stream(bytes),
    });
    assert.deepEqual(recovered.completedParts, [1]);
    const counters = target.db.raw.prepare(
      "SELECT in_flight_parts, parts_lease_expires_at FROM upload_sessions WHERE id = ?",
    ).get(created.id) as { in_flight_parts: number; parts_lease_expires_at: string | null };
    assert.equal(counters.in_flight_parts, 0, "başarılı parça slotu geri bırakmalı");
    const leases = target.db.raw.prepare("SELECT COUNT(*) AS count FROM upload_part_leases WHERE upload_session_id = ?")
      .get(created.id) as { count: number };
    assert.equal(leases.count, 0, "tamamlanan veya süresi dolan istek kirası kalmamalı");
  } finally {
    target.db.close();
  }
});

test("yaşam döngüsü nesneyi temizler fakat oturum ve olay kanıtını EXPIRED olarak tutar", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const created = await createUploadSession(target.dependencies, {
      userId: "user@sivas.bel.tr",
      unit: "Yazı İşleri",
      idempotencyKey: "expire-1",
      expectedByteSize: 4,
      declaredMediaType: "application/pdf",
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await uploadPart(target.dependencies, {
      sessionId: created.id, userId: "user@sivas.bel.tr", partNumber: 1,
      byteSize: 4, checksumSha256: sha256(bytes), body: stream(bytes),
    });
    target.setNow("2026-07-31T11:00:00.000Z");
    assert.deepEqual(await expireIncompleteUploads(target.dependencies), { expired: 1 });
    const session = await getUploadSession(target.dependencies, created.id, "user@sivas.bel.tr");
    assert.equal(session.status, "EXPIRED");
    assert.equal(await target.temporary.head(`temporary/${created.id}/payload`), null);
    assert.throws(() => target.db.raw.prepare("DELETE FROM upload_sessions WHERE id = ?").run(created.id));
    const events = target.db.raw.prepare(
      "SELECT event_number, event_hash FROM upload_session_events WHERE upload_session_id = ? ORDER BY event_number",
    ).all(created.id) as Array<{ event_number: number; event_hash: string }>;
    assert.deepEqual(events.map((event) => event.event_number), [1, 2]);
    assert.notEqual(events[0].event_hash, events[1].event_hash);
  } finally {
    target.db.close();
  }
});

test("tarama hata alındıları çoğalabilir; yalnız bir VERIFIED alındı vardır ve hiçbiri değiştirilemez", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const created = await createUploadSession(target.dependencies, {
      userId: "user@sivas.bel.tr", unit: "Yazı İşleri", idempotencyKey: "scan-1",
      expectedByteSize: 4, declaredMediaType: "application/pdf",
    });
    const insert = (id: string, result: "FAILED" | "VERIFIED", scanner: "ERROR" | "CLEAN") =>
      target.db.raw.prepare(`INSERT INTO ingest_receipts
        (id, upload_session_id, result, sha256, byte_size, declared_media_type, detected_media_type,
         type_validation_result, parser_name, parser_version, parser_result, scanner_engine, scanner_version, scanner_signature_version, scanner_result)
        VALUES (?, ?, ?, ?, 4, 'application/pdf', 'application/pdf', 'MATCH', 'qpdf', '12.2', 'VALID', 'clamav', '1.4', 'daily', ?)`)
        .run(id, created.id, result, "a".repeat(64), scanner);
    insert("r1", "FAILED", "ERROR");
    insert("r2", "FAILED", "ERROR");
    insert("r3", "VERIFIED", "CLEAN");
    assert.throws(() => insert("r4", "VERIFIED", "CLEAN"));
    assert.throws(() => target.db.raw.prepare("UPDATE ingest_receipts SET scanner_version = 'x' WHERE id = 'r1'").run());
    assert.throws(() => target.db.raw.prepare("DELETE FROM ingest_receipts WHERE id = 'r1'").run());
  } finally {
    target.db.close();
  }
});
