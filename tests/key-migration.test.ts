/**
 * F1.8 — Eski anahtar sınıflandırması ve yetkili taşıma testleri.
 *
 * Kabul ölçütleri (YOL_HARITASI_FAZLAR.md §F1.8):
 * - hedef anahtar varsa üzerine yazılmaz;
 * - taşıma öncesi/sonrası SHA aynıdır;
 * - kullanıcı isteği taşıma sırasında yanlış nesneyi sunmaz (atomik değişim);
 * - kanıt ve loglarda özgün dosya adı bulunmaz (maskeli biçim);
 * - eski nesne silinmez ve uzlaştırma onu sahipsiz saymaz.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { resolveOriginalObject } from "../lib/binary-objects.ts";
import {
  classifyMetadataFields,
  classifyObjectKey,
  maskObjectKey,
} from "../lib/key-classification.ts";
import {
  processNextKeyMigrationJob, readKeyMigrationSummary, runKeyInventorySlice,
} from "../lib/key-migration.ts";
import {
  MemoryImmutableVaultWriter,
  MemoryNamespace,
  MemoryObjectReader,
  MemoryStagingStorage,
  createNodeStreamingHasher,
} from "./memory-object-storage.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const NOW = new Date("2026-07-31T09:00:00.000Z");
const LEGACY_KEY = "originals/2025/tapu-Ahmet Yılmaz 12345678901.pdf";

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function fixture() {
  const db = createSqliteD1();
  const vault = new MemoryNamespace(() => NOW);
  const reader = new MemoryObjectReader(vault);
  let sequence = 0;
  let opaqueSequence = 0;
  return {
    db,
    vault,
    staging: new MemoryStagingStorage(vault),
    reader,
    writer: new MemoryImmutableVaultWriter(vault, reader),
    hasher: createNodeStreamingHasher(),
    randomId: () => `id-${++sequence}`,
    randomOpaqueId: () => `00000000-0000-4000-8000-${String(++opaqueSequence).padStart(12, "0")}`,
  };
}

type Fixture = ReturnType<typeof fixture>;

function dependencies(target: Fixture) {
  return {
    db: target.db,
    reader: target.reader,
    writer: target.writer,
    hasher: target.hasher,
    now: () => NOW,
    randomId: target.randomId,
    randomOpaqueId: target.randomOpaqueId,
  };
}

async function seedDocument(target: Fixture, id: string, key: string, content: string, options: {
  metadata?: Record<string, string>;
  writeObject?: boolean;
} = {}) {
  const digest = sha256(content);
  const byteSize = new TextEncoder().encode(content).byteLength;
  target.db.raw.prepare(`INSERT INTO archive_documents
    (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
    VALUES (?, ?, 'belge.pdf', ?, 'application/pdf', ?, ?, 'user@sivas.bel.tr')`)
    .run(id, `ARS-${id}`, key, byteSize, digest);
  target.db.raw.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, media_type, byte_size, sha256)
    VALUES (?, ?, 'original', ?, 'application/pdf', ?, ?)`)
    .run(`obj-${id}`, id, key, byteSize, digest);
  if (options.writeObject !== false) {
    await target.staging.put(key, content, {
      contentType: "application/pdf",
      customMetadata: options.metadata ?? { sha256: digest },
    });
  }
  return { key, digest, byteSize, objectId: `obj-${id}` };
}

// ---------------------------------------------------------------------------
// Sınıflandırma ve maskeleme.
// ---------------------------------------------------------------------------

test("politika uyumlu anahtarlar eski sayılmaz; dosya adı taşıyanlar göstergeleriyle yakalanır", () => {
  const uuid = "0f8b2c1d-3a4e-45f6-8a9b-0c1d2e3f4a5b";
  assert.equal(classifyObjectKey(`originals/${uuid}/${uuid}`, "original").legacy, false);
  assert.equal(classifyObjectKey(`derivatives/${uuid}/access/${uuid}`, "access").legacy, false);
  assert.equal(classifyObjectKey(`derivatives/${uuid}/access/${uuid}/part-0001.pdf`, "access").legacy, false);

  const legacy = classifyObjectKey(LEGACY_KEY, "original");
  assert.equal(legacy.legacy, true);
  assert.deepEqual(legacy.indicators, [
    "ELEVEN_DIGIT_RUN", "FILENAME_EXTENSION", "FILENAME_LIKE", "NAME_LIKE_CASING", "NON_ASCII", "WHITESPACE",
  ]);
  // Maskeli biçim yapıyı korur ama adı, kimlik numarasını ve sözcükleri taşımaz.
  assert.equal(legacy.maskedPattern, "aaaaaaaaa/9999/aaaa-Aaaaa Aaaaaa 99999999999.aaa");
  assert.ok(!legacy.maskedPattern.includes("Ahmet"));
  assert.ok(!legacy.maskedPattern.includes("12345678901"));
  assert.equal(maskObjectKey("originals/GİZLİ-Ad.pdf").includes("GİZLİ"), false);
});

test("metadata sınıflandırması ham ad/değer sızdırmadan bilinmeyen veya geçersiz alanı raporlar", () => {
  const uuid = "0f8b2c1d-3a4e-45f6-8a9b-0c1d2e3f4a5b";
  assert.deepEqual(classifyMetadataFields({ sha256: "a".repeat(64), documentId: uuid }), []);
  const findings = classifyMetadataFields({
    sha256: "x", originalName: "gizli-Ahmet Yılmaz.pdf", uploader: "ad",
  });
  assert.ok(findings.some((entry) => entry.startsWith("INVALID_SAFE_VALUE:")));
  assert.ok(findings.some((entry) => entry.startsWith("UNKNOWN_FIELD:")));
  assert.ok(!JSON.stringify(findings).includes("Ahmet"));
  assert.ok(!JSON.stringify(findings).includes("Yılmaz"));
  assert.ok(!JSON.stringify(findings).includes("originalName"));
  assert.deepEqual(classifyMetadataFields(undefined), []);
});

test("yalnız rakamdan oluşan hassas kimlik opak token sayılmaz; Unicode maske ham karakter sızdırmaz", () => {
  assert.equal(classifyObjectKey(
    "originals/12345678901/98765432109", "original",
  ).legacy, true);
  const masked = maskObjectKey("éЖ😀/12345678901");
  assert.ok(!masked.includes("é"));
  assert.ok(!masked.includes("Ж"));
  assert.ok(!masked.includes("😀"));
  assert.ok(!masked.includes("12345678901"));
});

// ---------------------------------------------------------------------------
// Envanter + taşıma.
// ---------------------------------------------------------------------------

test("eski anahtar envantere maskeli girer, if-absent kopyalanır, SHA doğrulanır ve referans atomik değişir", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const safeUuid = "0f8b2c1d-3a4e-45f6-8a9b-0c1d2e3f4a5b";
    const safe = await seedDocument(target, "uyumlu", `originals/${safeUuid}/${safeUuid}`, "politika uyumlu içerik");
    const legacy = await seedDocument(target, "eski", LEGACY_KEY, "eski anahtarlı içerik", {
      metadata: { sha256: sha256("eski anahtarlı içerik"), originalName: "tapu-Ahmet Yılmaz.pdf" },
    });

    const inventory = await runKeyInventorySlice(dependencies(target));
    assert.equal(inventory.enqueued, 1, "yalnız eski anahtar kuyruğa girer");
    const row = target.db.raw.prepare(`SELECT source_object_key, target_object_key, masked_key_pattern,
        classification_json, source_sha256, status FROM legacy_key_migrations`).get() as Record<string, string>;
    assert.equal(row.source_object_key, LEGACY_KEY);
    assert.equal(classifyObjectKey(row.target_object_key, "original").legacy, false);
    assert.ok(!row.target_object_key.includes("eski"));
    assert.ok(!row.target_object_key.includes(legacy.objectId));
    assert.ok(!row.masked_key_pattern.includes("Ahmet"), "envanter maskelidir");
    assert.ok(!row.classification_json.includes("Ahmet"));

    const migration = await processNextKeyMigrationJob(dependencies(target));
    assert.equal(migration.result, "COMPLETED");

    const done = target.db.raw.prepare(`SELECT status, target_sha256, verified_at, metadata_findings_json
      FROM legacy_key_migrations`).get() as Record<string, string>;
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.target_sha256, legacy.digest, "taşıma öncesi/sonrası SHA aynıdır");
    assert.ok(done.verified_at);
    const metadataFindings = JSON.parse(done.metadata_findings_json) as string[];
    assert.ok(metadataFindings.some((entry) => entry.startsWith("UNKNOWN_FIELD:")));
    assert.ok(!done.metadata_findings_json.includes("originalName"));

    // Referans atomik değişti; okuma yolu yeni anahtarı sunar.
    const resolved = await resolveOriginalObject(target.db, "eski");
    assert.equal(resolved?.object_key, row.target_object_key);
    assert.equal(resolved?.sha256, legacy.digest);

    // Hedef temiz metadata taşır; eski nesne SİLİNMEMİŞTİR (tasfiye ayrı roldedir).
    const targetEntry = target.vault.entries.get(row.target_object_key)!;
    assert.deepEqual(Object.keys(targetEntry.customMetadata ?? {}).sort(),
      ["objectClass", "sha256"]);
    assert.ok(target.vault.entries.has(LEGACY_KEY), "eski nesne geri dönüş süresi boyunca yerinde durur");

    // Denetim kanıtı ham anahtarı/özgün adı içermez.
    const audit = target.db.raw.prepare("SELECT details_json FROM audit_events").get() as { details_json: string };
    assert.ok(!audit.details_json.includes("Ahmet"));
    assert.ok(!audit.details_json.includes(LEGACY_KEY));

    // İkinci envanter koşusu mükerrer iş açmaz; uyumlu anahtar hiç girmez.
    target.db.raw.prepare("UPDATE maintenance_tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = 'legacy-key-inventory'").run();
    const second = await runKeyInventorySlice(dependencies(target));
    assert.equal(second.enqueued, 0);
    assert.equal((target.db.raw.prepare("SELECT COUNT(*) AS count FROM legacy_key_migrations").get() as { count: number }).count, 1);
    assert.ok(target.vault.entries.has(safe.key));
    const scopedSummary = await readKeyMigrationSummary(target.db, "Belirlenmedi");
    assert.equal(scopedSummary.completed, 1);
    assert.equal(scopedSummary.inventory, null, "birim kullanıcısına tüm arşiv ilerlemesi sızmaz");
    assert.ok((await readKeyMigrationSummary(target.db, "*")).inventory);
  } finally {
    target.db.close();
  }
});

test("anahtarı güvenli fakat metadata bulgulu nesne yeni opak anahtarla yeniden paketlenir", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const uuid = "0f8b2c1d-3a4e-45f6-8a9b-0c1d2e3f4a5b";
    const seeded = await seedDocument(target, "metadata", `originals/${uuid}/${uuid}`, "temiz içerik", {
      metadata: { sha256: sha256("temiz içerik"), originalName: "Ahmet Yılmaz.pdf" },
    });

    const inventory = await runKeyInventorySlice(dependencies(target));
    assert.equal(inventory.enqueued, 1);
    const queued = target.db.raw.prepare(`SELECT target_object_key, metadata_findings_json
      FROM legacy_key_migrations`).get() as Record<string, string>;
    assert.notEqual(queued.target_object_key, seeded.key);
    assert.ok(!queued.metadata_findings_json.includes("Ahmet"));

    assert.equal((await processNextKeyMigrationJob(dependencies(target))).result, "COMPLETED");
    const resolved = await resolveOriginalObject(target.db, "metadata");
    assert.equal(resolved?.object_key, queued.target_object_key);
    assert.deepEqual(target.vault.entries.get(queued.target_object_key)?.customMetadata, {
      sha256: seeded.digest,
      objectClass: "original",
    });
  } finally {
    target.db.close();
  }
});

test("türev ad alanı envantere girer ve kendi dar tüketicisi tarafından tamamlanır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const uuid = "0f8b2c1d-3a4e-45f6-8a9b-0c1d2e3f4a5b";
    await seedDocument(target, "turev", `originals/${uuid}/${uuid}`, "asıl içerik");
    const content = "erişim türevi";
    const digest = sha256(content);
    const bytes = new TextEncoder().encode(content).byteLength;
    const legacyDerivative = "derivatives/turev/erişim-Ahmet.pdf";
    target.db.raw.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, bucket_or_namespace, media_type, byte_size, sha256)
      VALUES ('access-turev', 'turev', 'access', ?, 'DERIVATIVE_FILES', 'application/pdf', ?, ?)`)
      .run(legacyDerivative, bytes, digest);
    await target.staging.put(legacyDerivative, content, {
      contentType: "application/pdf",
      customMetadata: { sha256: digest, objectClass: "access" },
    });

    const common = dependencies(target);
    const inventory = await runKeyInventorySlice({
      ...common,
      readerForNamespace: (namespace) => {
        assert.ok(namespace === "ARCHIVE_FILES" || namespace === "DERIVATIVE_FILES");
        return target.reader;
      },
    });
    assert.equal(inventory.enqueued, 1);
    assert.equal((await processNextKeyMigrationJob({
      ...common,
      namespace: "ARCHIVE_FILES",
    })).processed, false, "arşiv rolü türev işini alamaz");
    const migrated = await processNextKeyMigrationJob({
      ...common,
      namespace: "DERIVATIVE_FILES",
    });
    assert.equal(migrated.result, "COMPLETED");
    const object = target.db.raw.prepare("SELECT object_key FROM binary_objects WHERE id = 'access-turev'")
      .get() as { object_key: string };
    assert.equal(classifyObjectKey(object.object_key, "access").legacy, false);
  } finally {
    target.db.close();
  }
});

test("dolu hedef üzerine yazılmaz: içerik farklıysa iş başarısız kalır, aynıysa kurtarılır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const legacy = await seedDocument(target, "catisma", "eski/çakışan anahtar.pdf", "doğru içerik");
    await runKeyInventorySlice(dependencies(target));
    const row = target.db.raw.prepare("SELECT target_object_key FROM legacy_key_migrations").get() as { target_object_key: string };

    // Hedefte FARKLI içerik varsa üzerine yazılamaz ve doğrulama geçmez.
    await target.staging.put(row.target_object_key, "saldırgan içerik", { contentType: "application/pdf" });
    const conflicted = await processNextKeyMigrationJob(dependencies(target));
    assert.equal(conflicted.result, "RETRY");
    const attacker = target.vault.entries.get(row.target_object_key)!;
    assert.equal(new TextDecoder().decode(attacker.bytes), "saldırgan içerik", "hedef ezilmedi");
    const pointer = await resolveOriginalObject(target.db, "catisma");
    assert.equal(pointer?.object_key, legacy.key, "başarısız taşıma kullanıcıya yanlış nesne sunmaz");

    // Yanıt kaybı kurtarması: hedefte DOĞRU içerik varsa doğrulanıp devam edilir.
    // (Backoff penceresi test saatinde sabit olduğundan elle açılır.)
    target.db.raw.prepare("UPDATE legacy_key_migrations SET next_attempt_at = NULL").run();
    target.vault.entries.delete(row.target_object_key);
    await target.staging.put(row.target_object_key, "doğru içerik", {
      contentType: "application/pdf",
      customMetadata: { sha256: legacy.digest, objectClass: "original" },
    });
    const recovered = await processNextKeyMigrationJob(dependencies(target));
    assert.equal(recovered.result, "COMPLETED");
    assert.equal((await resolveOriginalObject(target.db, "catisma"))?.object_key, row.target_object_key);
  } finally {
    target.db.close();
  }
});
