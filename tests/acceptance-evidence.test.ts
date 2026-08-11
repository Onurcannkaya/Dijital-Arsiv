import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptanceEvidenceNotFoundError,
  ACCEPTANCE_SECOND_DERIVATIVE_PROFILE,
  enqueueAcceptanceSecondDerivative,
  exportAcceptancePortableManifest,
  acceptanceEvidenceAccessDecision,
  readAcceptanceEvidence,
  resolveAcceptancePrivateObjectLocator,
  secureAcceptanceTokenEqual,
} from "../lib/acceptance-evidence.ts";
import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { writeAuditEvent } from "../lib/audit.ts";
import { transitionIngestSession } from "../lib/ingest-events.ts";
import { canonicalJson, manifestDigest } from "../lib/storage-manifest.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const SESSION_ID = "acceptance-session-001";
const SHA = "a".repeat(64);

async function rejectedSession() {
  const db = createSqliteD1();
  await applyArchiveMigrations(db);
  await db.prepare(`INSERT INTO upload_sessions
    (id, tenant_id, user_id, unit, original_name, requested_document_type,
     idempotency_key, status, expected_byte_size, declared_media_type, expires_at,
     created_at, updated_at)
    VALUES (?, 'default', 'acceptance@sivas.bel.tr', 'Kabul Testleri', 'ornek.pdf',
      'Tasnif bekliyor', 'acceptance-idempotency-001', 'CREATED', 128,
      'application/pdf', '2026-08-01T00:00:00.000Z',
      '2026-07-31T10:00:00.000Z', '2026-07-31T10:00:00.000Z')`)
    .bind(SESSION_ID).run();
  const steps = [
    ["UPLOADING", "2026-07-31T10:00:01.000Z"],
    ["QUARANTINED", "2026-07-31T10:00:02.000Z"],
    ["SCANNING", "2026-07-31T10:00:03.000Z"],
  ] as const;
  for (const [to, now] of steps) {
    await transitionIngestSession(db, {
      sessionId: SESSION_ID,
      to,
      actor: { kind: "service", id: "acceptance-test" },
      now,
    });
  }
  await db.prepare(`INSERT INTO ingest_receipts
    (id, upload_session_id, result, sha256, byte_size, declared_media_type,
     detected_media_type, type_validation_result, parser_name, parser_version,
     parser_result, scanner_engine, scanner_version, scanner_signature_version,
     scanner_result, created_at)
    VALUES ('receipt-001', ?, 'REJECTED', ?, 128, 'application/pdf',
      'application/x-dosexec', 'MISMATCH', 'file-signature', '1',
      'VALID', 'clamav', '1.4.3', '2026073101', 'CLEAN',
      '2026-07-31T10:00:04.000Z')`).bind(SESSION_ID, SHA).run();
  await transitionIngestSession(db, {
    sessionId: SESSION_ID,
    to: "REJECTED",
    actor: { kind: "service", id: "content-scan" },
    ingestReceiptId: "receipt-001",
    now: "2026-07-31T10:00:05.000Z",
  });
  await db.prepare(`INSERT INTO ingest_objects
    (id, upload_session_id, object_class, object_key, storage_provider,
     bucket_or_namespace, media_type, byte_size, sha256)
    VALUES ('quarantine-object', ?, 'quarantine', 'private/quarantine/key',
      'r2', 'quarantine-private', 'application/pdf', 128, ?)`).bind(SESSION_ID, SHA).run();
  return db;
}

test("maskeli kabul kan?t? karar nedenini, olay zincirini ve yokluk say?lar?n? verir", async () => {
  const db = await rejectedSession();
  try {
    const evidence = await readAcceptanceEvidence(db, SESSION_ID);
    assert.equal(evidence.contractVersion, 1);
    assert.equal(evidence.terminalStatus, "REJECTED");
    assert.equal(evidence.decisionCode, "TYPE_MISMATCH");
    assert.equal(evidence.receipt?.typeValidationResult, "MISMATCH");
    assert.equal(evidence.receipt?.scannerVersion, "1.4.3");
    assert.equal(evidence.transitionChain.valid, true);
    assert.deepEqual(evidence.transitionChain.events.map((event) => event.to),
      ["UPLOADING", "QUARANTINED", "SCANNING", "REJECTED"]);
    assert.deepEqual(evidence.counts, {
      documents: 0,
      originalObjects: 0,
      ocrJobs: 0,
      verifiedPromotions: 0,
    });
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /object_key|bucket_or_namespace|actor_id|acceptance@sivas/i);
    const locator = await resolveAcceptancePrivateObjectLocator(db, SESSION_ID, "quarantine");
    assert.equal(locator.objectKey, "private/quarantine/key");
    assert.equal(locator.objectClass, "quarantine");
    assert.equal(locator.sha256, SHA);
  } finally {
    db.close();
  }
});

test("olay ?zeti bozulursa zincir kan?t? ge?ersiz olur", async () => {
  const db = await rejectedSession();
  try {
    db.raw.exec("DROP TRIGGER upload_session_events_no_update");
    db.raw.prepare("UPDATE upload_session_events SET event_hash = ? WHERE event_number = 2")
      .run("f".repeat(64));
    const evidence = await readAcceptanceEvidence(db, SESSION_ID);
    assert.equal(evidence.transitionChain.valid, false);
  } finally {
    db.close();
  }
});

test("bilinmeyen ve bi?imsiz oturum kimli?i tek tip bulunamad? hatas? verir", async () => {
  const db = createSqliteD1();
  await applyArchiveMigrations(db);
  try {
    await assert.rejects(() => readAcceptanceEvidence(db, "../secret"),
      AcceptanceEvidenceNotFoundError);
    await assert.rejects(() => readAcceptanceEvidence(db, "unknown-session"),
      AcceptanceEvidenceNotFoundError);
  } finally {
    db.close();
  }
});

test("kabul s?rr? ?zetlenerek kar??la?t?r?l?r", async () => {
  const token = "a".repeat(32);
  assert.equal(await secureAcceptanceTokenEqual(token, token), true);
  assert.equal(await secureAcceptanceTokenEqual("b".repeat(32), token), false);
  assert.equal(await secureAcceptanceTokenEqual("", token), false);
});

test("kan?t u? noktas? ?retimde g?r?nmez ve staging'de ayr? s?rla fail-closed ?al???r", async () => {
  const token = "t".repeat(32);
  assert.deepEqual(await acceptanceEvidenceAccessDecision({
    appEnv: "production", configuredToken: token, authorization: `Bearer ${token}`,
  }), { status: 404, message: "Kaynak bulunamad?." });
  assert.equal((await acceptanceEvidenceAccessDecision({
    appEnv: "staging", configuredToken: "short", authorization: "Bearer short",
  }))?.status, 503);
  assert.equal((await acceptanceEvidenceAccessDecision({
    appEnv: "staging", configuredToken: token, authorization: "Bearer wrong",
  }))?.status, 401);
  assert.equal(await acceptanceEvidenceAccessDecision({
    appEnv: "staging", configuredToken: token, authorization: `Bearer ${token}`,
  }), null);
});

async function acceptedSessionDb() {
  const db = createSqliteD1();
  await applyArchiveMigrations(db);
  await db.prepare(`INSERT INTO upload_sessions
    (id, user_id, unit, original_name, requested_document_type, idempotency_key,
     status, expected_byte_size, declared_media_type, expires_at)
    VALUES ('accepted-session-001', 'acceptance@sivas.bel.tr', 'Kabul Testleri',
     'accepted.pdf', 'Tasnif bekliyor', 'accepted-idempotency-001', 'ACCEPTED',
     128, 'application/pdf', '2026-08-01T00:00:00.000Z')`).run();
  await db.prepare(`INSERT INTO ingest_receipts
    (id, upload_session_id, result, sha256, byte_size, declared_media_type,
     detected_media_type, type_validation_result, parser_name, parser_version,
     parser_result, scanner_engine, scanner_version, scanner_signature_version, scanner_result)
    VALUES ('accepted-receipt', 'accepted-session-001', 'VERIFIED', ?, 128,
     'application/pdf', 'application/pdf', 'MATCH', 'qpdf', '1', 'VALID',
     'clamav', '1.4.3', '2026073101', 'CLEAN')`).bind(SHA).run();
  await db.prepare(`INSERT INTO archive_documents
    (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
    VALUES ('accepted-document', 'ARS-2026-TEST', 'accepted.pdf', 'opaque-test-key',
     'application/pdf', 128, ?, 'acceptance@sivas.bel.tr')`).bind(SHA).run();
  await db.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, storage_version_id, media_type, byte_size, sha256)
    VALUES ('accepted-original', 'accepted-document', 'original', 'opaque-test-key',
     'provider-version-1', 'application/pdf', 128, ?)`).bind(SHA).run();
  await db.prepare(`INSERT INTO promotion_jobs
    (id, upload_session_id, ingest_receipt_id, document_id, binary_object_id,
     target_object_key, sha256, status)
    VALUES ('accepted-promotion', 'accepted-session-001', 'accepted-receipt',
     'accepted-document', 'accepted-original', 'opaque-test-key', ?, 'COMPLETED')`).bind(SHA).run();
  return db;
}

test("ta??nabilir manifest ACCEPTED oturumdan sa?lay?c? alan? s?zd?rmadan d??a aktar?l?r", async () => {
  const db = await acceptedSessionDb();
  try {
    await writeAuditEvent(db, {
      documentId: "accepted-document", actor: "system:ingest-promotion",
      action: "document.received", details: { source: "acceptance-test" },
    });
    const exported = await exportAcceptancePortableManifest(db, "accepted-session-001");
    assert.equal(exported.documentId, "accepted-document");
    // ?zet, d?nen manifestin kanonik JSON'?ndan yeniden ?retilebilir olmal?d?r.
    assert.equal(exported.manifestDigest, await manifestDigest(exported.manifest));
    assert.deepEqual(exported.objectLocators, [{
      id: "accepted-original",
      objectClass: "original",
      namespace: "ARCHIVE_FILES",
      objectKey: "opaque-test-key",
      byteSize: 128,
      sha256: SHA,
    }]);
    // Manifest sa?lay?c? alan? ta??maz; fiziksel anahtar yaln?z locator'dad?r.
    const serialized = canonicalJson(exported.manifest);
    assert.doesNotMatch(serialized, /opaque-test-key|ARCHIVE_FILES|object_key|etag/i);
    // ACCEPTED olmayan oturum tek tip bulunamad? hatas? verir.
    await assert.rejects(() => exportAcceptancePortableManifest(db, "unknown-session"),
      AcceptanceEvidenceNotFoundError);
  } finally {
    db.close();
  }
});

test("ikinci profil kuyru?u idempotenttir ve kan?t yaln?z g?venli envanteri d?nd?r?r", async () => {
  const db = await acceptedSessionDb();
  try {
    const first = await enqueueAcceptanceSecondDerivative(db, "accepted-session-001");
    const second = await enqueueAcceptanceSecondDerivative(db, "accepted-session-001");
    assert.equal(first.enqueued, true);
    assert.equal(second.enqueued, false);
    assert.equal(first.profileVersion, ACCEPTANCE_SECOND_DERIVATIVE_PROFILE);
    const evidence = await readAcceptanceEvidence(db, "accepted-session-001");
    assert.deepEqual(evidence.originalInventory, [{
      id: "accepted-original", sha256: SHA, byteSize: 128, storageVersionId: "provider-version-1",
    }]);
    assert.equal(evidence.derivativeJobs.length, 1);
    assert.equal(evidence.derivativeJobs[0].profileVersion, "access-pdf-v2");
    assert.equal(evidence.derivativeJobs[0].status, "QUEUED");
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /opaque-test-key|object_key|bucket_or_namespace|storage_provider/i);
    const locator = await resolveAcceptancePrivateObjectLocator(db, "accepted-session-001", "original");
    assert.equal(locator.objectKey, "opaque-test-key");
    assert.equal(locator.objectClass, "original");
    assert.equal(locator.sha256, SHA);
  } finally {
    db.close();
  }
});
