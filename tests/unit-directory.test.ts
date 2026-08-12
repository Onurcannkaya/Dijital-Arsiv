/**
 * Müdürlük (kontrollü sözlük) yönetimi kuralları.
 *
 * Müdürlük değeri erişim kapsamıdır: kullanıcıların yetki alanı ve belgelerin
 * sahipliği buna dayanır. Bu yüzden listeden çıkarma silme değil
 * pasifleştirmedir ve liste hiçbir zaman tamamen boşaltılamaz.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { UNIT_VOCABULARY_CODE } from "../lib/archive-seed.ts";
import { loadVocabularyTerms } from "../lib/document-profile.ts";
import {
  UnitDirectoryError, createUnit, listUnits, setUnitActive, unitCodeFromLabel,
} from "../lib/unit-directory.ts";
import { listActivity } from "../lib/activity-log.ts";
import { createSqliteD1, type FakeD1 } from "./sqlite-d1.ts";

const ACTOR = "yonetici@sivas.bel.tr";

async function fixture(): Promise<FakeD1> {
  const db = createSqliteD1();
  await applyArchiveMigrations(db);
  return db;
}

const rejects = async (run: () => Promise<unknown>, code: string) => {
  await assert.rejects(run, (error: unknown) =>
    error instanceof UnitDirectoryError && error.code === code);
};

test("Türkçe adlardan güvenli sözlük kodu üretilir", () => {
  assert.equal(unitCodeFromLabel("Yazı İşleri Müdürlüğü"), "YAZI_ISLERI_MUDURLUGU");
  assert.equal(unitCodeFromLabel("İmar ve Şehircilik Müdürlüğü"), "IMAR_VE_SEHIRCILIK_MUDURLUGU");
});

test("müdürlük eklenir, listede görünür ve denetim kaydına yazılır", async () => {
  const db = await fixture();
  try {
    const created = await createUnit(db, { actor: ACTOR, label: "  Park ve   Bahçeler Müdürlüğü ", vocabularyCode: UNIT_VOCABULARY_CODE });
    assert.equal(created.label, "Park ve Bahçeler Müdürlüğü", "fazla boşluklar sadeleşmeli");
    assert.equal(created.active, true);

    const terms = await loadVocabularyTerms(db, UNIT_VOCABULARY_CODE);
    assert.ok(terms?.some((term) => term.label === "Park ve Bahçeler Müdürlüğü"), "yükleme listesinde görünmeli");

    const page = await listActivity(db, { unit: "*", includeUserEvents: true, kind: "user" });
    const event = page.entries.find((entry) => entry.targetEmail === created.code);
    assert.equal(event?.action, "unit.created");
  } finally { db.close(); }
});

test("aynı ad ya da kod ikinci kez eklenemez; geçersiz ad reddedilir", async () => {
  const db = await fixture();
  try {
    await createUnit(db, { actor: ACTOR, label: "Basın Yayın Müdürlüğü", vocabularyCode: UNIT_VOCABULARY_CODE });
    await rejects(() => createUnit(db, { actor: ACTOR, label: "Basın Yayın Müdürlüğü", vocabularyCode: UNIT_VOCABULARY_CODE }), "UNIT_EXISTS");
    await rejects(() => createUnit(db, { actor: ACTOR, label: "   ", vocabularyCode: UNIT_VOCABULARY_CODE }), "INVALID_LABEL");
    // Yalnız noktalama içeren ad geçerli kod üretemez.
    await rejects(() => createUnit(db, { actor: ACTOR, label: "!!!", vocabularyCode: UNIT_VOCABULARY_CODE }), "INVALID_LABEL");
  } finally { db.close(); }
});

test("pasifleştirme kaydı silmez: belge sahipliği ve kullanıcı kapsamı korunur", async () => {
  const db = await fixture();
  try {
    const unit = await createUnit(db, { actor: ACTOR, label: "Veteriner Müdürlüğü", vocabularyCode: UNIT_VOCABULARY_CODE });
    await db.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, unit, uploaded_by)
      VALUES ('d1', 'ARS-1', 'b.pdf', 'originals/d1', 'application/pdf', 10, ?, ?, 'memur@sivas.bel.tr')`)
      .bind("a".repeat(64), unit.label).run();
    await db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
      VALUES ('memur@sivas.bel.tr', 'Memur', 'reviewer', ?, 1)`).bind(unit.label).run();

    const disabled = await setUnitActive(db, { actor: ACTOR, code: unit.code, active: false, vocabularyCode: UNIT_VOCABULARY_CODE });
    assert.equal(disabled.active, false);
    assert.equal(disabled.documentCount, 1, "bağlı belge sayısı görünmeli");
    assert.equal(disabled.userCount, 1, "bağlı kullanıcı sayısı görünmeli");

    // Sözlük kaydı duruyor; yalnız seçilebilir listeden çıkıyor.
    assert.ok((await listUnits(db, UNIT_VOCABULARY_CODE)).some((entry) => entry.code === unit.code));
    const terms = await loadVocabularyTerms(db, UNIT_VOCABULARY_CODE);
    assert.ok(!terms?.some((term) => term.label === unit.label), "pasif müdürlük yükleme listesinde olmamalı");
    const document = await db.prepare("SELECT unit FROM archive_documents WHERE id = 'd1'").first<{ unit: string }>();
    assert.equal(document?.unit, unit.label, "belge sahipliği değişmemeli");

    const reactivated = await setUnitActive(db, { actor: ACTOR, code: unit.code, active: true, vocabularyCode: UNIT_VOCABULARY_CODE });
    assert.equal(reactivated.active, true);
  } finally { db.close(); }
});

test("son aktif müdürlük pasifleştirilemez", async () => {
  const db = await fixture();
  try {
    const units = await listUnits(db, UNIT_VOCABULARY_CODE);
    const active = units.filter((unit) => unit.active);
    // Tohum listesindeki müdürlükler tek tek kapatılır; sonuncusu reddedilmeli.
    for (const unit of active.slice(0, -1)) {
      await setUnitActive(db, { actor: ACTOR, code: unit.code, active: false, vocabularyCode: UNIT_VOCABULARY_CODE });
    }
    const last = active[active.length - 1];
    await rejects(() => setUnitActive(db, { actor: ACTOR, code: last.code, active: false, vocabularyCode: UNIT_VOCABULARY_CODE }), "LAST_UNIT");
    assert.ok((await loadVocabularyTerms(db, UNIT_VOCABULARY_CODE))?.length, "en az bir seçilebilir müdürlük kalmalı");
  } finally { db.close(); }
});

test("bilinmeyen müdürlük güncellenemez; aynı durum yeniden yazılmaz", async () => {
  const db = await fixture();
  try {
    await rejects(() => setUnitActive(db, { actor: ACTOR, code: "YOK", active: false, vocabularyCode: UNIT_VOCABULARY_CODE }), "UNIT_NOT_FOUND");

    const unit = await createUnit(db, { actor: ACTOR, label: "Kültür Müdürlüğü", vocabularyCode: UNIT_VOCABULARY_CODE });
    const before = (await listActivity(db, { unit: "*", includeUserEvents: true, kind: "user" })).entries.length;
    await setUnitActive(db, { actor: ACTOR, code: unit.code, active: true, vocabularyCode: UNIT_VOCABULARY_CODE });
    const after = (await listActivity(db, { unit: "*", includeUserEvents: true, kind: "user" })).entries.length;
    assert.equal(after, before, "değişiklik olmayan istek denetim kaydı üretmemeli");
  } finally { db.close(); }
});
