import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { processNextPromotionJob } from "../lib/ingest-promotion.ts";
import {
  ObjectStorageError,
  type ImmutableVaultWriter,
  type ObjectBody,
  type ObjectReader,
  type ObjectStat,
  type ObjectStorageValue,
  type PutObjectOptions,
} from "../lib/object-storage.ts";
import type { StreamingHasher } from "../lib/content-hasher.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const encoder = new TextEncoder();

type Stored = { bytes: Uint8Array; stat: ObjectStat };

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function streamOf(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function valueBytes(value: ObjectStorageValue) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ReadableStream) return await readStream(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

class MemoryReader implements ObjectReader {
  readonly objects: Map<string, Stored>;
  constructor(objects: Map<string, Stored>) {
    this.objects = objects;
  }

  async get(key: string): Promise<ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      ...stored.stat,
      body: streamOf(stored.bytes),
      bodySize: stored.bytes.byteLength,
      range: null,
    };
  }

  async head(key: string) {
    return this.objects.get(key)?.stat ?? null;
  }
}

class MemoryVaultWriter implements ImmutableVaultWriter {
  promoteCalls = 0;
  throwAfterWriteOnce = false;
  corruptWrites = false;

  private readonly source: ObjectReader;
  readonly objects: Map<string, Stored>;
  constructor(source: ObjectReader, objects: Map<string, Stored>) {
    this.source = source;
    this.objects = objects;
  }

  async putIfAbsent(key: string, value: ObjectStorageValue, options: PutObjectOptions) {
    if (this.objects.has(key)) {
      throw new ObjectStorageError("KEY_ALREADY_EXISTS", "target exists");
    }
    let bytes = await valueBytes(value);
    if (this.corruptWrites && bytes.byteLength > 0) {
      bytes = bytes.slice();
      bytes[0] ^= 0xff;
    }
    const stat: ObjectStat = {
      size: bytes.byteLength,
      contentType: options.contentType,
      etag: `etag-${this.objects.size + 1}`,
      providerVersionId: `version-${this.objects.size + 1}`,
      providerChecksumSha256: null,
      uploadedAt: NOW.toISOString(),
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { bytes, stat });
    if (this.throwAfterWriteOnce) {
      this.throwAfterWriteOnce = false;
      throw new ObjectStorageError("PROVIDER_UNAVAILABLE", "response lost after write");
    }
    return stat;
  }

  async promote(sourceKey: string, targetObjectKey: string, options: PutObjectOptions) {
    this.promoteCalls += 1;
    const source = await this.source.get(sourceKey);
    if (!source) throw new ObjectStorageError("OBJECT_NOT_FOUND", "source missing");
    return await this.putIfAbsent(targetObjectKey, source.body, options);
  }
}

const nodeHasher: StreamingHasher = {
  async sha256(stream) {
    const bytes = await readStream(stream);
    return { sha256Hex: sha256(bytes), byteSize: bytes.byteLength };
  },
};

function seedVerifiedSession(
  db: ReturnType<typeof createSqliteD1>,
  quarantine: Map<string, Stored>,
  id: string,
  bytes = encoder.encode("safe archive payload"),
) {
  const digest = sha256(bytes);
  const objectKey = `quarantine/${id}/payload`;
  db.raw.prepare(`INSERT INTO upload_sessions
      (id, user_id, unit, original_name, requested_document_type, idempotency_key,
       status, expected_byte_size, uploaded_byte_size, declared_media_type, expires_at)
    VALUES (?, 'user@sivas.bel.tr', 'Yazi Isleri', 'ornek.pdf', 'Tasnif bekliyor', ?,
      'VERIFIED', ?, ?, 'application/pdf', '2026-08-01T00:00:00Z')`)
    .run(id, `request-${id}`, bytes.byteLength, bytes.byteLength);
  db.raw.prepare(`INSERT INTO ingest_objects
      (id, upload_session_id, object_class, object_key, storage_provider,
       bucket_or_namespace, media_type, byte_size, sha256)
    VALUES (?, ?, 'quarantine', ?, 'r2', 'QUARANTINE_FILES', 'application/pdf', ?, ?)`)
    .run(`object-${id}`, id, objectKey, bytes.byteLength, digest);
  db.raw.prepare(`INSERT INTO ingest_receipts
      (id, upload_session_id, result, sha256, byte_size, declared_media_type,
       detected_media_type, type_validation_result, parser_name, parser_version,
       parser_result, scanner_engine, scanner_version, scanner_signature_version,
       scanner_result, verified_at)
    VALUES (?, ?, 'VERIFIED', ?, ?, 'application/pdf', 'application/pdf',
      'MATCH', 'qpdf', '12.2', 'VALID', 'clamav', '1.4', 'daily-1', 'CLEAN', ?)`)
    .run(`receipt-${id}`, id, digest, bytes.byteLength, NOW.toISOString());
  quarantine.set(objectKey, {
    bytes,
    stat: {
      size: bytes.byteLength,
      contentType: "application/pdf",
      etag: `quarantine-${id}`,
      providerVersionId: `quarantine-version-${id}`,
      providerChecksumSha256: null,
      uploadedAt: NOW.toISOString(),
    },
  });
  return digest;
}

function dependencies(
  db: ReturnType<typeof createSqliteD1>,
  quarantineObjects: Map<string, Stored>,
  vaultObjects: Map<string, Stored>,
  writer: MemoryVaultWriter,
  now: () => Date = () => NOW,
) {
  let sequence = 0;
  return {
    db,
    quarantineReader: new MemoryReader(quarantineObjects),
    vaultWriter: writer,
    vaultReader: new MemoryReader(vaultObjects),
    hasher: nodeHasher,
    now,
    randomId: () => `f15-${++sequence}`,
  };
}

test("verified quarantine object is conditionally promoted and fully verified before acceptance", async () => {
  const db = createSqliteD1();
  const quarantine = new Map<string, Stored>();
  const vault = new Map<string, Stored>();
  try {
    await applyArchiveMigrations(db);
    const digest = seedVerifiedSession(db, quarantine, "accept");
    const writer = new MemoryVaultWriter(new MemoryReader(quarantine), vault);
    const result = await processNextPromotionJob(dependencies(db, quarantine, vault, writer));

    assert.equal(result.result, "ACCEPTED");
    assert.equal(writer.promoteCalls, 1);
    const session = db.raw.prepare("SELECT status FROM upload_sessions WHERE id = 'accept'").get() as { status: string };
    assert.equal(session.status, "ACCEPTED");
    const document = db.raw.prepare("SELECT id, storage_key, sha256, byte_size, status FROM archive_documents").get() as Record<string, unknown>;
    const object = db.raw.prepare(`SELECT storage_version_id, sha256, byte_size, encryption_status
      FROM binary_objects WHERE object_class = 'original'`).get() as Record<string, unknown>;
    const receipt = db.raw.prepare(`SELECT result, quarantine_sha256, vault_sha256,
      expected_byte_size, vault_byte_size, vault_storage_version_id
      FROM promotion_receipts WHERE result = 'VERIFIED'`).get() as Record<string, unknown>;
    assert.equal(document.sha256, digest);
    assert.equal(object.sha256, digest);
    assert.equal(receipt.quarantine_sha256, digest);
    assert.equal(receipt.vault_sha256, digest);
    assert.equal(receipt.expected_byte_size, receipt.vault_byte_size);
    assert.equal(object.storage_version_id, receipt.vault_storage_version_id);
    assert.equal(object.encryption_status, "provider-managed");
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get()!.count, 1);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM audit_events").get()!.count, 1);
    assert.throws(() => db.raw.prepare("UPDATE promotion_receipts SET result = 'FAILED'").run());
    assert.throws(() => db.raw.prepare(`INSERT INTO promotion_receipts
      (id, promotion_job_id, lease_token, upload_session_id, ingest_receipt_id,
       result, source_object_key, target_object_key, quarantine_sha256,
       expected_byte_size, encryption_status, failure_code, failure_message)
      SELECT 'stale-receipt', id, 'stale-lease', upload_session_id, ingest_receipt_id,
        'FAILED', 'quarantine/stale', target_object_key, sha256, 1,
        'provider-managed', 'STALE', 'stale worker'
      FROM promotion_jobs LIMIT 1`).run());
    assert.ok(vault.has(String(document.storage_key)));
    // Servisler arası sözleşme: OCR servisi yalnız `originals/` önekini kabul
    // eder; terfi farklı önek üretirse her yeni belgenin OCR işi dead-letter olur.
    assert.match(String(document.storage_key), /^originals\//);
  } finally {
    db.close();
  }
});

test("response loss after immutable write is recovered without overwriting the vault object", async () => {
  const db = createSqliteD1();
  const quarantine = new Map<string, Stored>();
  const vault = new Map<string, Stored>();
  let current = NOW;
  try {
    await applyArchiveMigrations(db);
    seedVerifiedSession(db, quarantine, "retry");
    const writer = new MemoryVaultWriter(new MemoryReader(quarantine), vault);
    writer.throwAfterWriteOnce = true;
    const deps = dependencies(db, quarantine, vault, writer, () => current);

    const first = await processNextPromotionJob(deps);
    assert.equal(first.result, "FAILED");
    assert.equal(vault.size, 1, "immutable object must remain after finalization failure");
    current = new Date(NOW.getTime() + 31_000);
    const second = await processNextPromotionJob(deps);
    assert.equal(second.result, "ACCEPTED");
    assert.equal(vault.size, 1, "retry must not create or overwrite another original");
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM promotion_receipts WHERE result = 'FAILED'").get()!.count, 1);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM promotion_receipts WHERE result = 'VERIFIED'").get()!.count, 1);
  } finally {
    db.close();
  }
});

test("post-write full SHA mismatch keeps document and OCR records out of the database", async () => {
  const db = createSqliteD1();
  const quarantine = new Map<string, Stored>();
  const vault = new Map<string, Stored>();
  try {
    await applyArchiveMigrations(db);
    seedVerifiedSession(db, quarantine, "corrupt");
    const writer = new MemoryVaultWriter(new MemoryReader(quarantine), vault);
    writer.corruptWrites = true;
    const result = await processNextPromotionJob(dependencies(db, quarantine, vault, writer));

    assert.equal(result.result, "FAILED");
    assert.equal(result.errorCode, "VAULT_VERIFICATION_FAILED");
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM archive_documents").get()!.count, 0);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM binary_objects").get()!.count, 0);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get()!.count, 0);
    assert.equal(db.raw.prepare("SELECT status FROM upload_sessions WHERE id = 'corrupt'").get()!.status, "PROMOTING");
    assert.equal(vault.size, 1, "a failed immutable original is left for reconciliation, never deleted");
  } finally {
    db.close();
  }
});

test("ilk kopya kasaya girdikten sonra gelen aynı-SHA oturumu mükerrer olarak kapanır", async () => {
  const db = createSqliteD1();
  const quarantine = new Map<string, Stored>();
  const vault = new Map<string, Stored>();
  try {
    await applyArchiveMigrations(db);
    /*
     * Gerçek kullanıcı senaryosu: aynı dosya iki kez ART ARDA yüklenir.
     * İlk oturum normal terfiyle kasaya girer ve terfi işi COMPLETED kalır.
     * SHA koruması bir dönem COMPLETED işi de engel sayıyordu; ikinci oturum
     * aday olamıyor, mükerrer denetimine hiç ulaşamıyor ve sonsuza dek
     * VERIFIED durumunda asılı kalıyordu — memurun gördüğü "takıldı" buydu.
     */
    const bytes = encoder.encode("ayni dosya iki kez");
    seedVerifiedSession(db, quarantine, "ilk-kopya", bytes);
    const writer = new MemoryVaultWriter(new MemoryReader(quarantine), vault);
    const deps = dependencies(db, quarantine, vault, writer);
    const first = await processNextPromotionJob(deps);
    assert.equal(first.result, "ACCEPTED");
    const documentId = (db.raw.prepare("SELECT id FROM archive_documents").get() as { id: string }).id;

    seedVerifiedSession(db, quarantine, "ikinci-kopya", bytes);
    const second = await processNextPromotionJob(deps);
    assert.equal(second.result, "DUPLICATE", "ikinci kopya mükerrer olarak kapanmalı, askıda kalmamalı");
    assert.equal(second.duplicateOfDocumentId, documentId);
    const session = db.raw.prepare("SELECT status, duplicate_of_document_id FROM upload_sessions WHERE id = 'ikinci-kopya'")
      .get() as { status: string; duplicate_of_document_id: string };
    assert.equal(session.status, "DUPLICATE");
    assert.equal(session.duplicate_of_document_id, documentId);
    // Kasaya ikinci bir asıl yazılmaz; mükerrer, mevcut belgeye bağlanır.
    assert.equal(vault.size, 1);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM archive_documents").get()!.count, 1);
  } finally {
    db.close();
  }
});

test("accepted SHA duplicate closes the session without a new original or OCR job", async () => {
  const db = createSqliteD1();
  const quarantine = new Map<string, Stored>();
  const vault = new Map<string, Stored>();
  try {
    await applyArchiveMigrations(db);
    const digest = seedVerifiedSession(db, quarantine, "duplicate");
    db.raw.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
      VALUES ('existing-doc', 'ARS-EXISTING', 'existing.pdf', 'original/existing',
        'application/pdf', 20, ?, 'owner@sivas.bel.tr')`).run(digest);
    db.raw.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('existing-object', 'existing-doc', 'original', 'original/existing',
        'application/pdf', 20, ?)`).run(digest);
    const writer = new MemoryVaultWriter(new MemoryReader(quarantine), vault);
    const result = await processNextPromotionJob(dependencies(db, quarantine, vault, writer));

    assert.equal(result.result, "DUPLICATE");
    const session = db.raw.prepare(`SELECT status, duplicate_of_document_id
      FROM upload_sessions WHERE id = 'duplicate'`).get() as Record<string, unknown>;
    assert.equal(session.status, "DUPLICATE");
    assert.equal(session.duplicate_of_document_id, "existing-doc");
    assert.equal(writer.promoteCalls, 0);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM processing_jobs").get()!.count, 0);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM binary_objects").get()!.count, 1);
  } finally {
    db.close();
  }
});
