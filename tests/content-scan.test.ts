import assert from "node:assert/strict";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { processNextContentScanJob } from "../lib/content-scan.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const SHA = "a".repeat(64);
const NOW = new Date("2026-07-30T10:00:00.000Z");

function seedQuarantine(db: ReturnType<typeof createSqliteD1>, id: string, declared = "application/pdf") {
  db.raw.prepare(`INSERT INTO upload_sessions
      (id, user_id, unit, original_name, requested_document_type, idempotency_key,
       status, expected_byte_size, uploaded_byte_size, declared_media_type, expires_at)
    VALUES (?, 'user@sivas.bel.tr', 'Yazı İşleri', 'ornek.pdf', 'EVRAK', ?,
      'QUARANTINED', 4, 4, ?, '2026-08-01T00:00:00Z')`).run(id, `key-${id}`, declared);
  db.raw.prepare(`INSERT INTO ingest_objects
      (id, upload_session_id, object_class, object_key, storage_provider,
       bucket_or_namespace, media_type, byte_size, sha256)
    VALUES (?, ?, 'quarantine', ?, 'r2', 'QUARANTINE_FILES', ?, 4, ?)`)
    .run(`object-${id}`, id, `quarantine/${id}/payload`, declared, SHA);
}

function cleanResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    sha256: SHA,
    byteSize: 4,
    detectedMediaType: "application/pdf",
    typeValidationResult: "MATCH",
    parserName: "qpdf",
    parserVersion: "12.2",
    parserResult: "VALID",
    scannerEngine: "clamav",
    scannerVersion: "1.4",
    scannerSignatureVersion: "daily.cvd:1",
    scannerResult: "CLEAN",
    ...overrides,
  }), { headers: { "content-type": "application/json" } });
}

test("temiz, türü ve ayrıştırıcısı doğrulanan karantina nesnesi VERIFIED olur", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    seedQuarantine(db, "scan-clean");
    let sequence = 0;
    const result = await processNextContentScanJob({
      db,
      serviceUrl: "https://scan.internal",
      serviceToken: "secret",
      now: () => NOW,
      randomId: () => `scan-id-${++sequence}`,
      fetcher: async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
        assert.match(String(init?.body), /"fileExtension":"\.pdf"/);
        return cleanResponse();
      },
    });
    assert.deepEqual(result, { processed: true, result: "VERIFIED" });
    const session = db.raw.prepare("SELECT status FROM upload_sessions WHERE id = 'scan-clean'").get() as { status: string };
    assert.equal(session.status, "VERIFIED");
    const receipt = db.raw.prepare(`SELECT result, parser_result, scanner_result
      FROM ingest_receipts WHERE upload_session_id = 'scan-clean'`).get() as Record<string, string>;
    assert.deepEqual({ ...receipt }, { result: "VERIFIED", parser_result: "VALID", scanner_result: "CLEAN" });
  } finally {
    db.close();
  }
});

test("MIME/magic-byte uyuşmazlığı asla asıl alana ilerlemez ve REJECTED olur", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    seedQuarantine(db, "scan-mismatch");
    const result = await processNextContentScanJob({
      db,
      serviceUrl: "https://scan.internal",
      serviceToken: "secret",
      now: () => NOW,
      fetcher: async () => cleanResponse({
        detectedMediaType: "application/x-dosexec",
        typeValidationResult: "MISMATCH",
        parserName: "unsupported",
        parserVersion: "unknown",
        parserResult: "ERROR",
      }),
    });
    assert.deepEqual(result, { processed: true, result: "REJECTED" });
    const session = db.raw.prepare("SELECT status FROM upload_sessions WHERE id = 'scan-mismatch'").get() as { status: string };
    assert.equal(session.status, "REJECTED");
  } finally {
    db.close();
  }
});

test("tarama servisi kullanılamazsa fail-closed kalır, alındı ve backoff üretir", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    seedQuarantine(db, "scan-down");
    const result = await processNextContentScanJob({
      db,
      serviceUrl: "https://scan.internal",
      serviceToken: "secret",
      now: () => NOW,
      fetcher: async () => new Response("unavailable", { status: 503 }),
    });
    assert.deepEqual(result, { processed: true, result: "FAILED" });
    const session = db.raw.prepare("SELECT status FROM upload_sessions WHERE id = 'scan-down'").get() as { status: string };
    assert.equal(session.status, "QUARANTINED");
    const job = db.raw.prepare(`SELECT status, attempt, next_attempt_at
      FROM content_scan_jobs WHERE upload_session_id = 'scan-down'`).get() as Record<string, unknown>;
    assert.equal(job.status, "RETRY");
    assert.equal(job.attempt, 1);
    assert.ok(job.next_attempt_at);
    const receipt = db.raw.prepare(`SELECT result, scanner_result, parser_result
      FROM ingest_receipts WHERE upload_session_id = 'scan-down'`).get() as Record<string, string>;
    assert.deepEqual({ ...receipt }, { result: "FAILED", scanner_result: "ERROR", parser_result: "ERROR" });
  } finally {
    db.close();
  }
});
