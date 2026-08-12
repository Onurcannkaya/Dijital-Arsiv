/**
 * Kurum geneli işlem geçmişi kuralları.
 *
 * En kritik davranış kapsam sızdırmamaktır: müdürlük kapsamı dar olan
 * kullanıcı, başka müdürlüğün belge hareketlerini bu ekrandan göremez; yetki
 * olayları yalnız `users.manage` yetkisiyle gelir. Ayrıntı alanından kişisel
 * veri ve anahtar taşıyabilecek değerler süzülür (T-11 ölçütü).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { writeAuditEvent } from "../lib/audit.ts";
import { listActivity } from "../lib/activity-log.ts";
import { createUser, updateUser } from "../lib/user-directory.ts";
import { createSqliteD1, type FakeD1 } from "./sqlite-d1.ts";

const YAZI = "Yazı İşleri Müdürlüğü";
const IMAR = "İmar ve Şehircilik Müdürlüğü";
const ADMIN = "yonetici@sivas.bel.tr";

async function seedDocument(db: FakeD1, id: string, unit: string, reference: string) {
  await db.prepare(`INSERT INTO archive_documents
    (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, unit, uploaded_by)
    VALUES (?, ?, 'belge.pdf', ?, 'application/pdf', 128, ?, ?, 'memur@sivas.bel.tr')`)
    .bind(id, reference, `originals/${id}`, "a".repeat(64), unit).run();
}

async function fixture(): Promise<FakeD1> {
  const db = createSqliteD1();
  await applyArchiveMigrations(db);
  await db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
    VALUES (?, 'Yönetici', 'admin', '*', 1)`).bind(ADMIN).run();
  await seedDocument(db, "doc-yazi", YAZI, "ARS-2026-YAZI");
  await seedDocument(db, "doc-imar", IMAR, "ARS-2026-IMAR");
  await writeAuditEvent(db, { documentId: "doc-yazi", actor: "memur@sivas.bel.tr", action: "document.received", details: { objectClass: "original" } });
  await writeAuditEvent(db, { documentId: "doc-imar", actor: "imarci@sivas.bel.tr", action: "document.received", details: { objectClass: "original" } });
  return db;
}

test("dar müdürlük kapsamı başka müdürlüğün olaylarını sızdırmaz", async () => {
  const db = await fixture();
  try {
    const scoped = await listActivity(db, { unit: YAZI, includeUserEvents: false });
    assert.equal(scoped.entries.length, 1);
    assert.equal(scoped.entries[0].referenceNo, "ARS-2026-YAZI");
    assert.ok(!scoped.entries.some((entry) => entry.unit === IMAR), "kapsam dışı müdürlük görünmemeli");

    const unrestricted = await listActivity(db, { unit: "*", includeUserEvents: false });
    assert.equal(unrestricted.entries.length, 2, "`*` kapsamı bütün belgeleri görür");
  } finally { db.close(); }
});

test("yetki olayları yalnız users.manage ile gelir", async () => {
  const db = await fixture();
  try {
    await createUser(db, { actor: ADMIN, email: "yeni@sivas.bel.tr", role: "viewer", unit: "*", allowedUnits: [YAZI] });

    const withoutPermission = await listActivity(db, { unit: "*", includeUserEvents: false });
    assert.ok(!withoutPermission.entries.some((entry) => entry.kind === "user"),
      "yetkisiz kullanıcı rol değişikliklerini görmemeli");

    const withPermission = await listActivity(db, { unit: "*", includeUserEvents: true });
    const userEntry = withPermission.entries.find((entry) => entry.kind === "user");
    assert.equal(userEntry?.targetEmail, "yeni@sivas.bel.tr");
    assert.deepEqual(userEntry?.roleChange, { from: null, to: "viewer" });
  } finally { db.close(); }
});

test("rol ve erişim değişikliği okunabilir alanlara çevrilir", async () => {
  const db = await fixture();
  try {
    await createUser(db, { actor: ADMIN, email: "kisi@sivas.bel.tr", role: "viewer", unit: "*", allowedUnits: [YAZI] });
    await updateUser(db, { actor: ADMIN, email: "kisi@sivas.bel.tr", role: "reviewer", allowedUnits: [YAZI] });
    await updateUser(db, { actor: ADMIN, email: "kisi@sivas.bel.tr", active: false, allowedUnits: [YAZI] });

    const page = await listActivity(db, { unit: "*", includeUserEvents: true });
    const events = page.entries.filter((entry) => entry.kind === "user");
    assert.equal(events.length, 3);
    // Aynı milisaniyede yazılan olayların kendi aralarındaki sırası doğal
    // olarak belirsizdir; iddia sıra değil, değişikliklerin doğru çevrilmesi.
    assert.ok(events.some((entry) => entry.accessChange?.from === true && entry.accessChange.to === false),
      "erişim kapatma değişikliği okunabilir alana çevrilmeli");
    assert.ok(events.some((entry) => entry.roleChange?.from === "viewer" && entry.roleChange.to === "reviewer"),
      "rol değişikliği önceki ve sonraki değerle gelmeli");
    assert.ok(events.some((entry) => entry.roleChange?.from === null && entry.roleChange.to === "viewer"),
      "oluşturma olayında önceki rol boş olmalı");
  } finally { db.close(); }
});

test("ayrıntı alanından yalnız güvenli değerler geçer", async () => {
  const db = await fixture();
  try {
    await writeAuditEvent(db, {
      documentId: "doc-yazi", actor: "memur@sivas.bel.tr", action: "document.access-denied",
      details: {
        reason: "TICKET_INVALID",
        // Aşağıdakiler kişisel veri/anahtar taşıyabilir: dışarı verilmemeli.
        sha256: "b".repeat(64),
        objectKey: "originals/doc-yazi/orj",
        originalName: "Ahmet Yılmaz tapu.pdf",
      },
    });
    const page = await listActivity(db, { unit: YAZI, includeUserEvents: false });
    const denied = page.entries.find((entry) => entry.action === "document.access-denied");
    assert.deepEqual(denied?.details, { reason: "TICKET_INVALID" });
    const serialized = JSON.stringify(page);
    assert.ok(!serialized.includes("Ahmet"), "dosya adı sızmamalı");
    assert.ok(!serialized.includes("originals/"), "nesne anahtarı sızmamalı");
    assert.ok(!serialized.includes("b".repeat(64)), "SHA-256 sızmamalı");
  } finally { db.close(); }
});

test("tür süzgeci ve anahtar kümesi sayfalaması kararlı çalışır", async () => {
  const db = await fixture();
  try {
    await createUser(db, { actor: ADMIN, email: "sayfa@sivas.bel.tr", role: "viewer", unit: "*", allowedUnits: [YAZI] });

    const onlyDocuments = await listActivity(db, { unit: "*", includeUserEvents: true, kind: "document" });
    assert.ok(onlyDocuments.entries.every((entry) => entry.kind === "document"));
    const onlyUsers = await listActivity(db, { unit: "*", includeUserEvents: true, kind: "user" });
    assert.ok(onlyUsers.entries.every((entry) => entry.kind === "user"));

    const first = await listActivity(db, { unit: "*", includeUserEvents: true, limit: 1 });
    assert.equal(first.entries.length, 1);
    assert.ok(first.nextCursor);
    const second = await listActivity(db, { unit: "*", includeUserEvents: true, limit: 1, cursor: first.nextCursor });
    assert.equal(second.entries.length, 1);
    assert.notEqual(second.entries[0].id, first.entries[0].id, "imleç aynı kaydı tekrar vermemeli");
  } finally { db.close(); }
});

test("hiç kaynak seçilmediğinde boş sayfa döner", async () => {
  const db = await fixture();
  try {
    // Yetkisiz kullanıcı yalnız yetki olaylarını istediğinde sonuç boş olmalı.
    const page = await listActivity(db, { unit: YAZI, includeUserEvents: false, kind: "user" });
    assert.deepEqual(page, { entries: [], nextCursor: null });
  } finally { db.close(); }
});
