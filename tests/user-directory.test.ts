/**
 * Kullanıcı ve rol yönetimi kuralları.
 *
 * En kritik davranış kilitlenme korumasıdır: son aktif yönetici hiçbir yolla
 * yetkisiz bırakılamaz, aksi hâlde kurum kendi arşivinin yönetiminden çıkar.
 * Her değişiklik değişmez denetim kaydına yazılır.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import {
  UserDirectoryError, createUser, listUserAdminEvents, listUsers, updateUser,
} from "../lib/user-directory.ts";
import { createSqliteD1, type FakeD1 } from "./sqlite-d1.ts";

const UNITS = ["Yazı İşleri Müdürlüğü", "İmar ve Şehircilik Müdürlüğü"];
const ADMIN = "yonetici@sivas.bel.tr";

async function fixture(): Promise<FakeD1> {
  const db = createSqliteD1();
  await applyArchiveMigrations(db);
  await db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
    VALUES (?, 'Kurucu Yönetici', 'admin', '*', 1)`).bind(ADMIN).run();
  return db;
}

const rejects = async (run: () => Promise<unknown>, code: string) => {
  await assert.rejects(run, (error: unknown) =>
    error instanceof UserDirectoryError && error.code === code);
};

test("kullanıcı eklenir, kontrollü birim uygulanır ve denetim kaydı yazılır", async () => {
  const db = await fixture();
  try {
    const user = await createUser(db, {
      actor: ADMIN, email: "  Memur@Sivas.Bel.TR ", displayName: "Arşiv Memuru",
      role: "reviewer", unit: UNITS[0], allowedUnits: UNITS,
    });
    assert.equal(user.email, "memur@sivas.bel.tr", "e-posta normalize edilmeli");
    assert.equal(user.role, "reviewer");
    assert.equal(user.active, true);

    const events = await listUserAdminEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, "user.created");
    assert.equal(events[0].actor, ADMIN);
    assert.equal(events[0].previousState, null);
    assert.deepEqual(events[0].newState, { role: "reviewer", unit: UNITS[0], active: true });
  } finally { db.close(); }
});

test("geçersiz e-posta, rol, birim ve mükerrer kayıt reddedilir", async () => {
  const db = await fixture();
  try {
    const base = { actor: ADMIN, role: "viewer" as const, unit: "*", allowedUnits: UNITS };
    await rejects(() => createUser(db, { ...base, email: "gecersiz" }), "INVALID_EMAIL");
    await rejects(() => createUser(db, { ...base, email: "a@sivas.bel.tr", role: "superadmin" }), "INVALID_ROLE");
    // Serbest metin müdürlük asla kabul edilmez.
    await rejects(() => createUser(db, { ...base, email: "a@sivas.bel.tr", unit: "Uydurma Müdürlük" }), "INVALID_UNIT");
    await rejects(() => createUser(db, { ...base, email: ADMIN }), "USER_EXISTS");
  } finally { db.close(); }
});

test("son aktif yönetici rolü düşürülemez ve erişimi kapatılamaz", async () => {
  const db = await fixture();
  try {
    // Başka bir yönetici tarafından denense bile kilitlenme engellenir.
    await createUser(db, { actor: ADMIN, email: "ikinci@sivas.bel.tr", role: "viewer", unit: "*", allowedUnits: UNITS });
    await rejects(() => updateUser(db, {
      actor: "ikinci@sivas.bel.tr", email: ADMIN, role: "viewer", allowedUnits: UNITS,
    }), "LAST_ADMIN");
    await rejects(() => updateUser(db, {
      actor: "ikinci@sivas.bel.tr", email: ADMIN, active: false, allowedUnits: UNITS,
    }), "LAST_ADMIN");

    const admin = (await listUsers(db)).find((user) => user.email === ADMIN);
    assert.equal(admin?.role, "admin", "yönetici rolü korunmalı");
    assert.equal(admin?.active, true);
  } finally { db.close(); }
});

test("ikinci yönetici varken rol devri yapılabilir", async () => {
  const db = await fixture();
  try {
    await createUser(db, { actor: ADMIN, email: "yeni@sivas.bel.tr", role: "admin", unit: "*", allowedUnits: UNITS });
    const demoted = await updateUser(db, {
      actor: "yeni@sivas.bel.tr", email: ADMIN, role: "archive_manager", allowedUnits: UNITS,
    });
    assert.equal(demoted.role, "archive_manager");

    const events = await listUserAdminEvents(db);
    assert.equal(events[0].action, "user.updated");
    assert.deepEqual(events[0].previousState, { role: "admin", unit: "*", active: true });
    assert.deepEqual(events[0].newState, { role: "archive_manager", unit: "*", active: true });
  } finally { db.close(); }
});

test("yönetici kendi erişimini kapatamaz ve kendi rolünü düşüremez", async () => {
  const db = await fixture();
  try {
    // İkinci yönetici var: kilitlenme koruması değil, kaza koruması sınanır.
    await createUser(db, { actor: ADMIN, email: "yedek@sivas.bel.tr", role: "admin", unit: "*", allowedUnits: UNITS });
    await rejects(() => updateUser(db, { actor: ADMIN, email: ADMIN, active: false, allowedUnits: UNITS }), "SELF_DEACTIVATION");
    await rejects(() => updateUser(db, { actor: ADMIN, email: ADMIN, role: "viewer", allowedUnits: UNITS }), "SELF_DEMOTION");
  } finally { db.close(); }
});

test("bilinmeyen kullanıcı güncellenemez; değişiklik yoksa denetim kaydı büyümez", async () => {
  const db = await fixture();
  try {
    await rejects(() => updateUser(db, { actor: ADMIN, email: "yok@sivas.bel.tr", role: "viewer", allowedUnits: UNITS }), "USER_NOT_FOUND");

    await createUser(db, { actor: ADMIN, email: "sabit@sivas.bel.tr", role: "viewer", unit: "*", allowedUnits: UNITS });
    const before = (await listUserAdminEvents(db)).length;
    await updateUser(db, { actor: ADMIN, email: "sabit@sivas.bel.tr", role: "viewer", unit: "*", active: true, allowedUnits: UNITS });
    assert.equal((await listUserAdminEvents(db)).length, before, "aynı değerlerle yapılan istek kayıt üretmemeli");
  } finally { db.close(); }
});

test("denetim kaydı değiştirilemez ve silinemez", async () => {
  const db = await fixture();
  try {
    await createUser(db, { actor: ADMIN, email: "iz@sivas.bel.tr", role: "viewer", unit: "*", allowedUnits: UNITS });
    assert.throws(() => db.raw.prepare("UPDATE user_admin_events SET actor = 'saldirgan'").run());
    assert.throws(() => db.raw.prepare("DELETE FROM user_admin_events").run());
  } finally { db.close(); }
});

test("pasif kullanıcı yeniden etkinleştirilebilir ve liste aktifleri önce verir", async () => {
  const db = await fixture();
  try {
    await createUser(db, { actor: ADMIN, email: "pasif@sivas.bel.tr", role: "viewer", unit: "*", allowedUnits: UNITS });
    await updateUser(db, { actor: ADMIN, email: "pasif@sivas.bel.tr", active: false, allowedUnits: UNITS });
    const afterDisable = (await listUsers(db)).find((user) => user.email === "pasif@sivas.bel.tr");
    assert.equal(afterDisable?.active, false);

    const reactivated = await updateUser(db, { actor: ADMIN, email: "pasif@sivas.bel.tr", active: true, allowedUnits: UNITS });
    assert.equal(reactivated.active, true);
    assert.equal((await listUsers(db))[0].active, true, "aktif kullanıcılar listenin başında olmalı");
  } finally { db.close(); }
});
