/**
 * F1.6 — Kalıcı bütünlük taraması ve iki yönlü uzlaştırma testleri.
 *
 * Kabul ölçütleri (YOL_HARITASI_FAZLAR.md §F1.6):
 * - boyut ve metadata değişmeden bozulan içerik yalnız tam taramada yakalanır;
 * - bulgu sonraki temiz dilimde silinmez ve kendiliğinden çözülmez;
 * - uzlaştırma sayfalı/kaldığı yerden devam eder, yaş toleranslıdır;
 * - uzlaştırma hiçbir nesneyi silmez, hiçbir kaydı düşürmez.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ARCHIVE_SCHEMA_VERSION, applyArchiveMigrations } from "../lib/archive-schema.ts";
import { runIntegritySlice } from "../lib/integrity.ts";
import { runReconciliationSlice } from "../lib/reconciliation.ts";
import {
  MemoryNamespace,
  MemoryObjectReader,
  MemoryStagingStorage,
  MemoryStorageInventory,
  createNodeStreamingHasher,
} from "./memory-object-storage.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const OLD_TIMESTAMP = "2026-07-29T12:00:00.000Z";

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function fixture() {
  const db = createSqliteD1();
  const vault = new MemoryNamespace(() => new Date(OLD_TIMESTAMP));
  return {
    db,
    vault,
    staging: new MemoryStagingStorage(vault),
    reader: new MemoryObjectReader(vault),
    inventory: new MemoryStorageInventory(vault),
    hasher: createNodeStreamingHasher(),
  };
}

type Fixture = ReturnType<typeof fixture>;

async function seedDocument(target: Fixture, id: string, content: string, options: {
  writeObject?: boolean;
  createdAt?: string;
} = {}) {
  const key = `originals/${id}/object`;
  const digest = sha256(content);
  // Türkçe karakterler UTF-16 uzunluğu ile bayt boyutunu ayrıştırır; yetkili
  // kayıt gerçek UTF-8 bayt boyutunu tutar.
  const byteSize = new TextEncoder().encode(content).byteLength;
  target.db.raw.prepare(`INSERT INTO archive_documents
    (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
    VALUES (?, ?, 'belge.pdf', ?, 'application/pdf', ?, ?, 'user@sivas.bel.tr')`)
    .run(id, `ARS-${id}`, key, byteSize, digest);
  target.db.raw.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, media_type, byte_size, sha256, created_at)
    VALUES (?, ?, 'original', ?, 'application/pdf', ?, ?, ?)`)
    .run(`obj-${id}`, id, key, byteSize, digest, options.createdAt ?? OLD_TIMESTAMP);
  if (options.writeObject !== false) {
    await target.staging.put(key, content, {
      contentType: "application/pdf",
      customMetadata: { sha256: digest },
    });
  }
  return { key, digest };
}

/** Günlük yeniden başlatma kapısını test için açar. */
function restartScan(target: Fixture, taskId: string) {
  target.db.raw.prepare("UPDATE maintenance_tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?")
    .run(taskId);
}

async function runIntegrityToCompletion(target: Fixture, batchSize = 2) {
  for (let guard = 0; guard < 50; guard += 1) {
    const result = await runIntegritySlice(target.db, target.reader, target.hasher, batchSize);
    if (!result.claimed) return null;
    if (result.done) return result;
  }
  throw new Error("bütünlük koşusu beklenen dilim sayısında bitmedi");
}

async function runReconciliationToCompletion(target: Fixture, batchSize = 2) {
  for (let guard = 0; guard < 50; guard += 1) {
    const result = await runReconciliationSlice({
      db: target.db,
      inventory: target.inventory,
      reader: target.reader,
      now: () => NOW,
    }, { batchSize, minAgeMinutes: 60 });
    if (!result.claimed) return null;
    if (result.done) return result;
  }
  throw new Error("uzlaştırma koşusu beklenen dilim sayısında bitmedi");
}

test("tam tarama, boyut ve metadata aynıyken bozulan içeriği yakalar; hızlı tarama yakalamaz", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const healthy = await seedDocument(target, "saglam", "sağlam içerik ------ A");
    const tampered = await seedDocument(target, "bozuk", "bozulacak içerik --- B");

    // Kontrollü bozulma: aynı boyut, aynı custom metadata, aynı sağlayıcı
    // checksum'ı; yalnız baytlar değişir (kanıt rehberi T-08 senaryosu).
    const entry = target.vault.entries.get(tampered.key)!;
    const corrupted = new TextEncoder().encode("bozulmuş içerik --- B");
    assert.equal(corrupted.byteLength, entry.bytes.byteLength, "test kurgusu: boyut aynı kalmalı");
    entry.bytes = corrupted;

    // İlk koşu hızlı profildir ve metadata değişmediği için bulgu üretmez.
    const quick = await runIntegrityToCompletion(target);
    assert.equal(quick?.profile, "quick");
    const findings = target.db.raw.prepare("SELECT COUNT(*) AS count FROM integrity_findings").get() as { count: number };
    assert.equal(findings.count, 0, "hızlı profil metadata aynıyken bozulmayı göremez");

    // İkinci koşu tam profildir: akışlı SHA bozulmayı yakalar.
    restartScan(target, "integrity-scan");
    const full = await runIntegrityToCompletion(target);
    assert.equal(full?.profile, "full");
    const rows = target.db.raw.prepare(`SELECT object_key, finding_type, severity, status,
        expected_sha256, actual_sha256 FROM integrity_findings`).all() as Array<Record<string, string>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].object_key, tampered.key);
    assert.equal(rows[0].finding_type, "HASH_MISMATCH");
    assert.equal(rows[0].severity, "CRITICAL");
    assert.equal(rows[0].status, "OPEN");
    assert.equal(rows[0].expected_sha256, tampered.digest);
    assert.equal(rows[0].actual_sha256, sha256("bozulmuş içerik --- B"));

    // Sağlam nesne hiçbir profde bulgu üretmedi.
    assert.ok(!rows.some((row) => row.object_key === healthy.key));

    // Koşu raporu: kapsam (profil), sayım ve sonuç kalıcıdır.
    const run = target.db.raw.prepare(`SELECT profile, status, checked_count, finding_count, completed_at
      FROM integrity_runs WHERE profile = 'full' AND status = 'COMPLETED'`).get() as Record<string, unknown>;
    assert.equal(run.checked_count, 2);
    assert.equal(run.finding_count, 1);
    assert.ok(run.completed_at);
  } finally {
    target.db.close();
  }
});

test("bulgu sonraki temiz koşuda silinmez, mükerrer açılmaz ve kendiliğinden çözülmez", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    const seeded = await seedDocument(target, "kalici", "kalıcı bulgu içeriği");
    target.vault.entries.delete(seeded.key); // nesne kayboldu → MISSING

    const first = await runIntegrityToCompletion(target);
    assert.equal(first?.profile, "quick");
    const countFindings = () => (target.db.raw.prepare(
      "SELECT COUNT(*) AS count FROM integrity_findings WHERE finding_type = 'MISSING'",
    ).get() as { count: number }).count;
    assert.equal(countFindings(), 1);

    // Sorun sürerken ikinci koşu mükerrer bulgu açmaz.
    restartScan(target, "integrity-scan");
    await runIntegrityToCompletion(target);
    assert.equal(countFindings(), 1, "çözülmemiş bulgu yinelenmez");
    const repeatedRun = target.db.raw.prepare(`SELECT finding_count FROM integrity_runs
      WHERE status = 'COMPLETED' ORDER BY rowid DESC LIMIT 1`).get() as { finding_count: number };
    assert.equal(repeatedRun.finding_count, 1,
      "koşu özeti yeni alarmı değil, tekrar gözlenen ihlali saymalı");

    // Nesne geri gelse bile bulgu kendiliğinden kapanmaz; çözüm yetkili sürece aittir.
    await target.staging.put(seeded.key, "kalıcı bulgu içeriği", {
      contentType: "application/pdf",
      customMetadata: { sha256: seeded.digest },
    });
    restartScan(target, "integrity-scan");
    await runIntegrityToCompletion(target);
    const finding = target.db.raw.prepare(
      "SELECT status, resolved_at FROM integrity_findings WHERE finding_type = 'MISSING'",
    ).get() as { status: string; resolved_at: string | null };
    assert.equal(finding.status, "OPEN", "temiz dilim bulguyu kapatamaz");
    assert.equal(finding.resolved_at, null);
  } finally {
    target.db.close();
  }
});

test("uzlaştırma sahipsiz nesneyi ve dosyasız kaydı bulur; yaş toleransı ve terfi penceresi sahte bulgu üretmez", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    // Sağlıklı çift: kayıt + nesne.
    await seedDocument(target, "esli", "kayıtlı ve nesnesi olan");
    // Dosyasız kayıt: eski kayıt, deposunda nesne yok.
    const missing = await seedDocument(target, "dosyasiz", "nesnesi silinmiş", { writeObject: false });
    // Yaş toleransı: yeni kayıt, nesnesi henüz yok — bulgu OLMAMALI.
    await seedDocument(target, "taze", "henüz yazılıyor", {
      writeObject: false,
      createdAt: NOW.toISOString(),
    });
    // Sahipsiz nesne: depoda var, yetkili kayıt yok.
    await target.staging.put("originals/sahipsiz/object", "kayıtsız bayt", {
      contentType: "application/pdf",
      customMetadata: { sha256: sha256("kayıtsız bayt") },
    });
    // Terfi penceresi: hedef anahtar depoda var, işi hâlâ PROMOTING — bulgu OLMAMALI.
    await target.staging.put("originals/terfide/object", "terfi sürüyor", {
      contentType: "application/pdf",
      customMetadata: { sha256: sha256("terfi sürüyor") },
    });
    target.db.raw.prepare(`INSERT INTO upload_sessions
      (id, user_id, unit, original_name, requested_document_type, idempotency_key,
       expected_byte_size, declared_media_type, expires_at)
      VALUES ('s-terfi', 'user@sivas.bel.tr', 'Yazı İşleri', 'belge.pdf', 'Tasnif bekliyor',
        'terfi-1', 10, 'application/pdf', '2026-08-01T00:00:00Z')`).run();
    target.db.raw.prepare(`INSERT INTO ingest_receipts
      (id, upload_session_id, result, sha256, byte_size, declared_media_type, detected_media_type,
       type_validation_result, parser_name, parser_version, parser_result,
       scanner_engine, scanner_version, scanner_signature_version, scanner_result, verified_at)
      VALUES ('r-terfi', 's-terfi', 'VERIFIED', ?, 10, 'application/pdf', 'application/pdf',
        'MATCH', 'qpdf', '11', 'VALID', 'clamav', '1.4', 'daily-1', 'CLEAN', CURRENT_TIMESTAMP)`)
      .run(sha256("terfi sürüyor"));
    target.db.raw.prepare(`INSERT INTO promotion_jobs
      (id, upload_session_id, ingest_receipt_id, document_id, binary_object_id,
       target_object_key, sha256, status, attempt, max_attempts, created_at, updated_at)
      VALUES ('pj-1', 's-terfi', 'r-terfi', 'd-terfi', 'o-terfi',
        'originals/terfide/object', ?, 'PROMOTING', 1, 5, ?, ?)`)
      .run(sha256("terfi sürüyor"), NOW.toISOString(), NOW.toISOString());

    const objectCountBefore = target.vault.entries.size;
    const recordCountBefore = (target.db.raw.prepare("SELECT COUNT(*) AS count FROM binary_objects").get() as { count: number }).count;

    // batchSize=2 ile birden çok dilim gerekir: sayfalama ve devam kanıtı.
    const completed = await runReconciliationToCompletion(target, 2);
    assert.ok(completed?.done);

    const rows = target.db.raw.prepare(`SELECT record_kind, record_id, object_key, finding_type, severity, status
      FROM reconciliation_findings ORDER BY finding_type`).all() as Array<Record<string, string>>;
    assert.deepEqual(rows.map((row) => [row.finding_type, row.object_key]), [
      ["MISSING_OBJECT", missing.key],
      ["ORPHAN_OBJECT", "originals/sahipsiz/object"],
    ]);
    assert.equal(rows[0].record_kind, "BINARY_OBJECT");
    assert.equal(rows[0].record_id, "obj-dosyasiz");
    assert.equal(rows[0].severity, "CRITICAL");
    assert.equal(rows[1].record_kind, "STORAGE_OBJECT");
    assert.equal(rows[1].severity, "HIGH");

    // Uzlaştırma hiçbir şeyi silmez ve düşürmez.
    assert.equal(target.vault.entries.size, objectCountBefore);
    assert.ok(target.vault.entries.has("originals/sahipsiz/object"));
    const recordCountAfter = (target.db.raw.prepare("SELECT COUNT(*) AS count FROM binary_objects").get() as { count: number }).count;
    assert.equal(recordCountAfter, recordCountBefore);

    // Koşu raporu kalıcıdır ve ikinci koşu mükerrer bulgu açmaz.
    const run = target.db.raw.prepare(`SELECT checked_count, finding_count, completed_at
      FROM reconciliation_runs WHERE status = 'COMPLETED'`).get() as Record<string, unknown>;
    assert.equal(run.finding_count, 2);
    assert.ok(run.completed_at);
    restartScan(target, "reconciliation-scan");
    await runReconciliationToCompletion(target, 2);
    const total = target.db.raw.prepare("SELECT COUNT(*) AS count FROM reconciliation_findings").get() as { count: number };
    assert.equal(total.count, 2, "çözülmemiş uzlaştırma bulgusu yinelenmez");
  } finally {
    target.db.close();
  }
});

test("süresi dolmuş RUNNING kirası kurtarılır ve koşu sabit anlık görüntüde tamamlanır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    await seedDocument(target, "ilk", "ilk anlık görüntü nesnesi");

    const firstSlice = await runIntegritySlice(target.db, target.reader, target.hasher, 1);
    assert.equal(firstSlice.checked, 1);
    assert.equal(firstSlice.done, false);

    // Koşu başladıktan sonra gelen kayıt bu koşunun su işaretinin dışındadır.
    await seedDocument(target, "sonra", "koşu sırasında eklenen nesne");
    // Önceki Worker çökmüş gibi RUNNING + süresi dolmuş kira bırakır.
    target.db.raw.prepare(`UPDATE maintenance_tasks SET status = 'RUNNING',
      lease_token = 'dead-worker', locked_until = '2000-01-01 00:00:00'
      WHERE id = 'integrity-scan'`).run();

    const recovered = await runIntegritySlice(target.db, target.reader, target.hasher, 1);
    assert.equal(recovered.done, true, "süresi dolmuş RUNNING işi devralınamadı");
    const firstRun = target.db.raw.prepare(`SELECT checked_count, snapshot_max_rowid
      FROM integrity_runs WHERE status = 'COMPLETED' ORDER BY rowid LIMIT 1`)
      .get() as { checked_count: number; snapshot_max_rowid: number };
    assert.equal(firstRun.checked_count, 1, "koşu sırasında gelen nesne anlık görüntüye sızdı");
    assert.ok(firstRun.snapshot_max_rowid > 0);

    restartScan(target, "integrity-scan");
    await runIntegrityToCompletion(target, 1);
    const secondRun = target.db.raw.prepare(`SELECT checked_count FROM integrity_runs
      WHERE status = 'COMPLETED' ORDER BY rowid DESC LIMIT 1`).get() as { checked_count: number };
    assert.equal(secondRun.checked_count, 2, "sonradan gelen nesne sonraki koşuda kapsanmadı");
  } finally {
    target.db.close();
  }
});

test("sağlayıcı kesintisi kalıcı bozulma bulgusu üretmez; dilim yeniden denemeye kalır", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    await seedDocument(target, "kesinti", "sağlayıcı kesintisi örneği");
    const unavailableReader = {
      get: target.reader.get.bind(target.reader),
      async head() { throw new Error("provider temporarily unavailable"); },
    };
    await assert.rejects(
      runIntegritySlice(target.db, unavailableReader, target.hasher, 1),
      /temporarily unavailable/,
    );
    const task = target.db.raw.prepare(`SELECT status, lease_token, locked_until
      FROM maintenance_tasks WHERE id = 'integrity-scan'`).get() as Record<string, unknown>;
    assert.equal(task.status, "FAILED");
    assert.equal(task.lease_token, null);
    assert.equal(task.locked_until, null);
    const count = target.db.raw.prepare("SELECT COUNT(*) AS count FROM integrity_findings")
      .get() as { count: number };
    assert.equal(count.count, 0, "geçici sağlayıcı hatası bozulma bulgusu oldu");
  } finally {
    target.db.close();
  }
});

test("uzlaştırma eksik asıl kaydı bulur ve genç depo nesnesini sahipsiz saymaz", async () => {
  const target = fixture();
  try {
    await applyArchiveMigrations(target.db);
    target.db.raw.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by, created_at)
      VALUES ('kayitsiz-belge', 'ARS-KAYITSIZ', 'belge.pdf', 'originals/kayitsiz-belge/object',
        'application/pdf', 8, ?, 'user@sivas.bel.tr', ?)`)
      .run(sha256("sekizbyt"), OLD_TIMESTAMP);

    await target.staging.put("originals/eski-sahipsiz/object", "eski sahipsiz", {
      contentType: "application/pdf",
      customMetadata: { sha256: sha256("eski sahipsiz") },
    });
    await target.staging.put("originals/genc-sahipsiz/object", "genç sahipsiz", {
      contentType: "application/pdf",
      customMetadata: { sha256: sha256("genç sahipsiz") },
    });
    target.vault.entries.get("originals/genc-sahipsiz/object")!.uploadedAt = NOW.toISOString();

    await runReconciliationToCompletion(target, 1);
    const rows = target.db.raw.prepare(`SELECT record_kind, record_id, object_key, finding_type
      FROM reconciliation_findings ORDER BY finding_type`).all() as Array<Record<string, string>>;
    assert.deepEqual(rows.map((row) => [row.finding_type, row.object_key]), [
      ["MISSING_RECORD", "originals/kayitsiz-belge/object"],
      ["ORPHAN_OBJECT", "originals/eski-sahipsiz/object"],
    ]);
    assert.equal(rows[0].record_kind, "ARCHIVE_DOCUMENT");
    assert.equal(rows[0].record_id, "kayitsiz-belge");
    assert.ok(!rows.some((row) => row.object_key === "originals/genc-sahipsiz/object"));
  } finally {
    target.db.close();
  }
});

test("v15 veritabanı veri kaybetmeden kiralı ve su işaretli v16 şemasına yükselir", async () => {
  const db = createSqliteD1();
  try {
    db.raw.exec(`
      CREATE TABLE schema_state (id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO schema_state (id, version) VALUES ('archive', 15);
      CREATE TABLE maintenance_tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'PENDING', cursor TEXT,
        processed INTEGER NOT NULL DEFAULT 0, total INTEGER, locked_until TEXT,
        last_error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO maintenance_tasks (id, status, processed) VALUES ('legacy-task', 'DONE', 7);
      CREATE TABLE integrity_runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'RUNNING', profile TEXT NOT NULL DEFAULT 'quick',
        cursor TEXT, checked_count INTEGER NOT NULL DEFAULT 0, finding_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
      );
      CREATE TABLE reconciliation_runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'RUNNING', cursor TEXT,
        checked_count INTEGER NOT NULL DEFAULT 0, finding_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
      );
    `);

    const result = await applyArchiveMigrations(db);
    assert.deepEqual(result, { applied: true, from: 15, to: ARCHIVE_SCHEMA_VERSION });
    const columns = (table: string) => {
      const rows = db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.map((row) => row.name);
    };
    assert.ok(columns("maintenance_tasks").includes("lease_token"));
    assert.ok(columns("integrity_runs").includes("snapshot_max_rowid"));
    assert.ok(columns("reconciliation_runs").includes("binary_snapshot_max_rowid"));
    assert.ok(columns("reconciliation_runs").includes("document_snapshot_max_rowid"));
    const preserved = db.raw.prepare("SELECT status, processed FROM maintenance_tasks WHERE id = 'legacy-task'")
      .get() as { status: string; processed: number };
    assert.equal(preserved.status, "DONE");
    assert.equal(preserved.processed, 7);
  } finally {
    db.close();
  }
});
