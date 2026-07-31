/**
 * F1.10 — Taşınabilir paket, ikinci sağlayıcı doğrulaması ve geri yükleme.
 *
 * Kabul ölçütleri (YOL_HARITASI_FAZLAR.md §F1.10):
 * - geri yüklenen her nesnenin SHA'sı manifestle eşleşir;
 * - paket başka bir S3 uyumlu hedefe aktarılır ve adaptörle okunur;
 * - sağlayıcı ETag/sürüm kimliği taşınabilir bütünlük kanıtı sayılmaz;
 * - belge üst veri, ilişkiler, türevler ve denetim bölümüyle geri kazanılır.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { resolveOriginalObject } from "../lib/binary-objects.ts";
import {
  buildPortableManifest,
  canonicalJson,
  exportPortablePackage,
  manifestDigest,
  restorePortablePackage,
  verifyAuditLinkage,
  verifyPortablePackage,
} from "../lib/storage-manifest.ts";
import {
  MemoryNamespace,
  MemoryObjectReader,
  MemoryStagingStorage,
  createNodeStreamingHasher,
} from "./memory-object-storage.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const GENERATED_AT = "2026-07-31T12:00:00.000Z";
const PREFIX = "packages/d1";

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function fixture() {
  const db = createSqliteD1();
  const archive = new MemoryNamespace(() => new Date(GENERATED_AT));
  const derivative = new MemoryNamespace(() => new Date(GENERATED_AT));
  // İkinci sağlayıcı: kaynaktan bağımsız ETag/sürüm sayaçları üretir.
  const target = new MemoryNamespace(() => new Date(GENERATED_AT));
  return {
    db,
    archive,
    derivative,
    target,
    archiveStaging: new MemoryStagingStorage(archive),
    derivativeStaging: new MemoryStagingStorage(derivative),
    targetStaging: new MemoryStagingStorage(target),
    targetReader: new MemoryObjectReader(target),
    hasher: createNodeStreamingHasher(),
    readerForNamespace(namespace: string) {
      if (namespace === "ARCHIVE_FILES") return new MemoryObjectReader(this.archive);
      if (namespace === "DERIVATIVE_FILES") return new MemoryObjectReader(this.derivative);
      throw new Error(`bilinmeyen ad alanı: ${namespace}`);
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

async function seedDocument(target: Fixture) {
  const originalContent = "asıl belge içeriği";
  const accessContent = "erişim türevi içeriği";
  const originalSha = sha256(originalContent);
  const accessSha = sha256(accessContent);
  target.db.raw.prepare(`INSERT INTO archive_documents
    (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
     document_type, unit, status, uploaded_by, created_at, updated_at)
    VALUES ('d1', 'ARS-D1', 'tapu.pdf', 'originals/d1/orj', 'application/pdf', ?, ?,
      'Tapu', 'Yazı İşleri', 'archived', 'user@sivas.bel.tr',
      '2026-07-30T09:00:00.000Z', '2026-07-30T10:00:00.000Z')`)
    .run(new TextEncoder().encode(originalContent).byteLength, originalSha);
  target.db.raw.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, media_type, byte_size, sha256)
    VALUES ('orj-1', 'd1', 'original', 'originals/d1/orj', 'application/pdf', ?, ?)`)
    .run(new TextEncoder().encode(originalContent).byteLength, originalSha);
  target.db.raw.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, media_type, byte_size, sha256,
     bucket_or_namespace, derived_from_id, generator, page_start, page_end)
    VALUES ('acc-1', 'd1', 'access', 'derivatives/d1/access/acc-1', 'application/pdf', ?, ?,
      'DERIVATIVE_FILES', 'orj-1', 'pdfium:141.0:access-pdf-v1', 1, 3)`)
    .run(new TextEncoder().encode(accessContent).byteLength, accessSha);
  await target.archiveStaging.put("originals/d1/orj", originalContent, {
    contentType: "application/pdf", customMetadata: { sha256: originalSha },
  });
  await target.derivativeStaging.put("derivatives/d1/access/acc-1", accessContent, {
    contentType: "application/pdf", customMetadata: { sha256: accessSha },
  });

  target.db.raw.prepare(`INSERT INTO entities
    (id, entity_type, display_label, authority_source, external_id, entity_status, created_by)
    VALUES ('ent-1', 'PARCEL', '123 ada 4 parsel', 'ARCHIVE', NULL, 'PROVISIONAL', 'user@sivas.bel.tr')`).run();
  target.db.raw.prepare(`INSERT INTO document_entity_relations
    (id, document_id, entity_id, relation_type, relation_source, verification_status,
     verified_by, verified_at, created_by)
    VALUES ('rel-1', 'd1', 'ent-1', 'SUBJECT', 'HUMAN', 'VERIFIED',
      'memur@sivas.bel.tr', '2026-07-30T11:00:00.000Z', 'memur@sivas.bel.tr')`).run();
  target.db.raw.prepare(`INSERT INTO ocr_pages
    (id, document_id, page_number, width, height, full_text, confirmed_text,
     confirmed_by, confirmed_at, model)
    VALUES ('page-1', 'd1', 1, 1240, 1754, 'tam metin', 'onaylı metin',
      'memur@sivas.bel.tr', '2026-07-30T11:30:00.000Z', 'PP-OCRv5')`).run();

  const hash1 = sha256("olay-1");
  const hash2 = sha256("olay-2");
  target.db.raw.prepare(`INSERT INTO audit_events
    (id, document_id, event_number, actor, action, details_json, previous_hash, event_hash, created_at)
    VALUES ('ev-1', 'd1', 1, 'system:ingest-promotion', 'document.received', '{}', NULL, ?, '2026-07-30T10:00:00.000Z')`)
    .run(hash1);
  target.db.raw.prepare(`INSERT INTO audit_events
    (id, document_id, event_number, actor, action, details_json, previous_hash, event_hash, created_at)
    VALUES ('ev-2', 'd1', 2, 'memur@sivas.bel.tr', 'document.viewed', '{}', ?, ?, '2026-07-30T11:00:00.000Z')`)
    .run(hash1, hash2);
  return { originalSha, accessSha };
}

test("manifest kanonik ve deterministiktir; sağlayıcı alanları taşımaz", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    await seedDocument(target);
    const first = await buildPortableManifest(target.db, "d1", { generatedAt: GENERATED_AT });
    const second = await buildPortableManifest(target.db, "d1", { generatedAt: GENERATED_AT });
    assert.equal(canonicalJson(first), canonicalJson(second), "manifest deterministik olmalı");
    assert.equal(await manifestDigest(first), await manifestDigest(second));

    const serialized = canonicalJson(first);
    for (const forbidden of ["object_key", "objectKey", "etag", "providerVersionId", "storage_key", "ARCHIVE_FILES"]) {
      assert.ok(!serialized.includes(forbidden), `manifest sağlayıcı alanı taşımamalı: ${forbidden}`);
    }
    assert.equal(first.objects.length, 2);
    assert.equal(first.relations.length, 1);
    assert.equal(first.ocrPages.length, 1);
    assert.equal(first.auditChain.length, 2);
    assert.ok(verifyAuditLinkage(first.auditChain));
  } finally {
    target.db.close();
  }
});

test("paket ikinci S3 uyumlu hedefe aktarılır; SHA doğrulanır, ETag kanıt sayılmaz", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const seeded = await seedDocument(target);
    const exported = await exportPortablePackage({
      db: target.db,
      readerForNamespace: (namespace) => target.readerForNamespace(namespace),
      target: target.targetStaging,
      hasher: target.hasher,
    }, "d1", PREFIX, { generatedAt: GENERATED_AT });
    assert.equal(exported.objectCount, 2);

    // Hedef sağlayıcının ETag/sürüm kimliği kaynaktan bağımsızdır; doğrulama
    // yalnız içerik SHA'sına dayanır ve geçer.
    const stat = await target.targetReader.head(`${PREFIX}/objects/orj-1`);
    assert.ok(stat?.etag && stat.providerVersionId, "hedef kendi sağlayıcı kimliklerini üretir");
    const verification = await verifyPortablePackage(
      { reader: target.targetReader, hasher: target.hasher }, exported.manifest, PREFIX);
    assert.deepEqual(verification, { verified: true, failures: [] });

    // Hedefteki nesne bozulursa doğrulama başarısız olur.
    const entry = target.target.entries.get(`${PREFIX}/objects/orj-1`)!;
    const original = entry.bytes;
    entry.bytes = new TextEncoder().encode("bozulmuş içerik!!!");
    const tampered = await verifyPortablePackage(
      { reader: target.targetReader, hasher: target.hasher }, exported.manifest, PREFIX);
    assert.equal(tampered.verified, false);
    assert.ok(tampered.failures.some((failure) => failure.startsWith("OBJECT_SHA_MISMATCH:orj-1")));
    entry.bytes = original;

    // Manifest alanı değişirse özet uyuşmaz.
    const forged = { ...exported.manifest, document: { ...exported.manifest.document, unit: "Başka" } };
    const forgedCheck = await verifyPortablePackage(
      { reader: target.targetReader, hasher: target.hasher }, forged, PREFIX);
    assert.ok(forgedCheck.failures.includes("MANIFEST_DIGEST_MISMATCH"));

    assert.equal(seeded.originalSha, exported.manifest.document.sha256);
  } finally {
    target.db.close();
  }
});

test("paket bağımsız alana belge bağlamıyla geri yüklenir", async () => {
  const source = fixture();
  const restoreDb = createSqliteD1();
  const restoreNamespace = new MemoryNamespace(() => new Date(GENERATED_AT));
  try {
    await applyArchiveMigrations(source.db);
    await applyArchiveMigrations(restoreDb);
    await seedDocument(source);
    const exported = await exportPortablePackage({
      db: source.db,
      readerForNamespace: (namespace) => source.readerForNamespace(namespace),
      target: source.targetStaging,
      hasher: source.hasher,
    }, "d1", PREFIX, { generatedAt: GENERATED_AT });

    const result = await restorePortablePackage({
      db: restoreDb,
      packageReader: source.targetReader,
      restoreStorage: new MemoryStagingStorage(restoreNamespace),
      hasher: source.hasher,
    }, exported.manifest, PREFIX);
    assert.deepEqual(result, {
      restored: true,
      documentId: "d1",
      objectCount: 2,
      relationCount: 1,
      ocrPageCount: 1,
      auditChainVerified: true,
    });

    // Belge bağlamı: üst veri, nesneler, ilişkiler ve OCR metni geri geldi.
    const restored = await resolveOriginalObject(restoreDb, "d1");
    assert.equal(restored?.sha256, exported.manifest.document.sha256);
    const reader = new MemoryObjectReader(restoreNamespace);
    const body = await reader.get(restored!.object_key);
    const digest = await source.hasher.sha256(body!.body);
    assert.equal(digest.sha256Hex, exported.manifest.document.sha256,
      "geri yüklenen nesnenin SHA'sı manifestle eşleşmeli");
    const counts = restoreDb.raw.prepare(`SELECT
        (SELECT COUNT(*) FROM binary_objects) AS objects,
        (SELECT COUNT(*) FROM document_entity_relations) AS relations,
        (SELECT COUNT(*) FROM ocr_pages) AS pages`).get() as Record<string, number>;
    assert.deepEqual([counts.objects, counts.relations, counts.pages], [2, 1, 1]);

    // Bozuk denetim zinciri geri yüklemeyi durdurur.
    const brokenManifest = {
      ...exported.manifest,
      auditChain: exported.manifest.auditChain.map((event, index) =>
        index === 1 ? { ...event, previousHash: sha256("yanlış") } : event),
    };
    const brokenDb = createSqliteD1();
    try {
      await applyArchiveMigrations(brokenDb);
      await assert.rejects(restorePortablePackage({
        db: brokenDb,
        packageReader: source.targetReader,
        restoreStorage: new MemoryStagingStorage(new MemoryNamespace()),
        hasher: source.hasher,
      }, brokenManifest, PREFIX), /AUDIT_CHAIN_LINKAGE/);
    } finally {
      brokenDb.close();
    }
  } finally {
    source.db.close();
    restoreDb.close();
  }
});
