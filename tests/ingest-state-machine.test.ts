import assert from "node:assert/strict";
import test from "node:test";

import {
  INGEST_SESSION_STATUSES,
  decideIngestTransition,
  isTerminalIngestStatus,
} from "../lib/ingest-state-machine.ts";
import {
  IngestContractError,
  MAX_INGEST_BYTES,
  assertIngestSize,
  assertIngestStateUpdate,
  decideVerifiedIngest,
} from "../lib/ingest-contract.ts";

test("normal kabul zinciri yalnız tanımlı ileri geçişlere izin verir", () => {
  const chain = [
    "CREATED", "UPLOADING", "QUARANTINED", "SCANNING",
    "VERIFIED", "PROMOTING", "ACCEPTED",
  ] as const;
  for (let index = 0; index < chain.length - 1; index += 1) {
    assert.deepEqual(decideIngestTransition(chain[index], chain[index + 1]), {
      allowed: true,
      operatorRetry: false,
    });
  }
  assert.equal(decideIngestTransition("CREATED", "ACCEPTED").allowed, false);
  assert.equal(decideIngestTransition("ACCEPTED", "UPLOADING").allowed, false);
});

test("mükerrer içerik VERIFIED aşamasından terminal DUPLICATE durumuna gider", () => {
  assert.equal(decideIngestTransition("VERIFIED", "DUPLICATE").allowed, true);
  assert.equal(decideIngestTransition("PROMOTING", "DUPLICATE").allowed, true);
  assert.equal(isTerminalIngestStatus("DUPLICATE"), true);
  assert.equal(decideIngestTransition("DUPLICATE", "PROMOTING").allowed, false);
});

test("FAILED -> PROMOTING yalnız tam kanıtlı operatör yeniden denemesidir", () => {
  const evidence = {
    actorKind: "operator" as const,
    actorId: "operator@sivas.bel.tr",
    reason: "Sağlayıcı kesintisi sonrası yeniden terfi",
    quarantineObjectAvailable: true,
    verifiedReceiptAvailable: true,
    retryWindowOpen: true,
  };
  assert.deepEqual(decideIngestTransition("FAILED", "PROMOTING", evidence), {
    allowed: true,
    operatorRetry: true,
  });
  assert.equal(decideIngestTransition("FAILED", "PROMOTING", { ...evidence, actorKind: "user" }).allowed, false);
  assert.equal(decideIngestTransition("FAILED", "PROMOTING", { ...evidence, reason: " " }).allowed, false);
  assert.equal(decideIngestTransition("FAILED", "PROMOTING", { ...evidence, verifiedReceiptAvailable: false }).allowed, false);
});

test("durum sözlüğü kapalıdır ve terminal durumlar yeniden açılamaz", () => {
  assert.equal(INGEST_SESSION_STATUSES.length, 11);
  for (const status of ["ACCEPTED", "REJECTED", "DUPLICATE", "EXPIRED"] as const) {
    assert.equal(isTerminalIngestStatus(status), true);
  }
});

test("boyut ve iyimser eşzamanlılık girdileri sınırda doğrulanır", () => {
  assert.doesNotThrow(() => assertIngestSize(1));
  assert.doesNotThrow(() => assertIngestSize(MAX_INGEST_BYTES));
  assert.throws(() => assertIngestSize(0), IngestContractError);
  assert.throws(() => assertIngestSize(MAX_INGEST_BYTES + 1), IngestContractError);
  assert.throws(() => assertIngestStateUpdate({
    sessionId: "s1",
    expectedStateVersion: -1,
    from: "CREATED",
    to: "UPLOADING",
  }), IngestContractError);
});

test("sunucu SHA eşleşmesi yeni belge/asıl/OCR üretmeyen DUPLICATE kararıdır", () => {
  assert.deepEqual(decideVerifiedIngest("document-42"), {
    status: "DUPLICATE",
    duplicateOfDocumentId: "document-42",
    createDocument: false,
    createOriginal: false,
    enqueueOcr: false,
  });
  assert.equal(decideVerifiedIngest(null).status, "PROMOTING");
});