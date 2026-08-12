/**
 * Kullanıcı ve rol yönetimi (yetki dizini).
 *
 * Yetkilendirme kararları arşivin en hassas yüzeyidir: bir belgeyi kimin
 * görebileceği, indirebileceği ve arşivleyebileceği buradan belirlenir. Bu
 * yüzden modül üç kuralı zorlar:
 *
 * 1. **Kilitlenme koruması.** Sistemde her zaman en az bir aktif `admin`
 *    kalmalıdır; son yöneticinin rolünü düşürmek ya da erişimini kapatmak
 *    reddedilir. Aksi hâlde kurum kendi arşivinin yönetiminden kilitlenir ve
 *    kurtarma yalnız veritabanına elle müdahaleyle mümkün olur.
 * 2. **Kendi yetkisini kapatamama.** Yönetici kendi erişimini kapatamaz ve
 *    kendi rolünü düşüremez; bu kaza korumasıdır, yetki devri başka bir
 *    yönetici tarafından yapılır.
 * 3. **Değişmez denetim.** Her oluşturma/değişiklik `user_admin_events`
 *    tablosuna önceki ve sonraki durumla yazılır (güncelleme/silme
 *    tetikleyiciyle reddedilir).
 *
 * Birim (`unit`) değeri ya `*` (bütün müdürlükler) ya da kontrollü müdürlük
 * listesindeki bir değerdir; serbest metin kabul edilmez.
 */

import { normalizeEmail, type ArchiveRole } from "./authorization.ts";

export const ARCHIVE_ROLES: readonly ArchiveRole[] = ["admin", "archive_manager", "reviewer", "viewer"];
export const ALL_UNITS = "*";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_DISPLAY_NAME = 120;

export type DirectoryUser = {
  email: string;
  displayName: string;
  role: ArchiveRole;
  unit: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UserAdminEvent = {
  id: string;
  actor: string;
  targetEmail: string;
  action: "user.created" | "user.updated";
  previousState: UserState | null;
  newState: UserState;
  createdAt: string;
};

type UserState = { role: ArchiveRole; unit: string; active: boolean };

type UserRow = {
  email: string;
  display_name: string;
  role: ArchiveRole;
  unit: string;
  active: number;
  created_at: string;
  updated_at: string;
};

export class UserDirectoryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "UserDirectoryError";
    this.code = code;
    this.status = status;
  }
}

function toDirectoryUser(row: UserRow): DirectoryUser {
  return {
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    unit: row.unit,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stateOf(row: UserRow): UserState {
  return { role: row.role, unit: row.unit, active: row.active === 1 };
}

export async function listUsers(db: D1Database): Promise<DirectoryUser[]> {
  const result = await db.prepare(`SELECT email, display_name, role, unit, active, created_at, updated_at
    FROM archive_users ORDER BY active DESC, role, email`).all<UserRow>();
  return (result.results ?? []).map(toDirectoryUser);
}

async function loadUser(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare(`SELECT email, display_name, role, unit, active, created_at, updated_at
    FROM archive_users WHERE email = ?`).bind(email).first<UserRow>();
}

/** Verilen kullanıcı dışındaki aktif yönetici sayısı. */
async function otherActiveAdminCount(db: D1Database, email: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM archive_users
    WHERE role = 'admin' AND active = 1 AND email <> ?`).bind(email).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function assertRole(role: unknown): asserts role is ArchiveRole {
  if (typeof role !== "string" || !ARCHIVE_ROLES.includes(role as ArchiveRole)) {
    throw new UserDirectoryError("INVALID_ROLE", "Geçerli bir rol seçilmelidir.");
  }
}

function normalizeUnit(unit: unknown, allowedUnits: readonly string[]): string {
  const value = String(unit ?? "").trim();
  if (!value) throw new UserDirectoryError("INVALID_UNIT", "Müdürlük değeri gereklidir.");
  if (value === ALL_UNITS) return ALL_UNITS;
  // Kontrollü liste verilmemişse (sözlük henüz yüklenmemiş kurulum) yalnız
  // `*` kabul edilir; serbest metin müdürlük kapsamı asla açılmaz.
  if (!allowedUnits.includes(value)) {
    throw new UserDirectoryError("INVALID_UNIT", "Müdürlük değeri kontrollü listede bulunmuyor.");
  }
  return value;
}

function normalizeDisplayName(value: unknown, fallback: string): string {
  const name = String(value ?? "").trim();
  if (!name) return fallback;
  if (name.length > MAX_DISPLAY_NAME) {
    throw new UserDirectoryError("INVALID_DISPLAY_NAME", "Ad soyad en çok 120 karakter olabilir.");
  }
  return name;
}

async function recordEvent(
  db: D1Database,
  input: { actor: string; targetEmail: string; action: UserAdminEvent["action"]; previous: UserState | null; next: UserState },
) {
  await db.prepare(`INSERT INTO user_admin_events
      (id, actor, target_email, action, previous_state, new_state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.actor, input.targetEmail, input.action,
      input.previous ? JSON.stringify(input.previous) : null,
      JSON.stringify(input.next), new Date().toISOString()).run();
}

export type CreateUserInput = {
  actor: string;
  email: unknown;
  displayName?: unknown;
  role: unknown;
  unit: unknown;
  allowedUnits: readonly string[];
};

/**
 * Kullanıcıyı dizine ekler. Kişi henüz oturum açmamış olabilir; kayıt önceden
 * tanımlanır ve ilk girişinde bu rolle karşılanır.
 */
export async function createUser(db: D1Database, input: CreateUserInput): Promise<DirectoryUser> {
  const email = normalizeEmail(String(input.email ?? ""));
  if (!EMAIL_PATTERN.test(email)) {
    throw new UserDirectoryError("INVALID_EMAIL", "Geçerli bir e-posta adresi gereklidir.");
  }
  assertRole(input.role);
  const unit = normalizeUnit(input.unit, input.allowedUnits);
  const displayName = normalizeDisplayName(input.displayName, email.split("@")[0]);
  if (await loadUser(db, email)) {
    throw new UserDirectoryError("USER_EXISTS", "Bu e-posta adresi zaten tanımlı.", 409);
  }

  const next: UserState = { role: input.role, unit, active: true };
  await db.prepare(`INSERT INTO archive_users (email, display_name, role, unit, active)
    VALUES (?, ?, ?, ?, 1)`).bind(email, displayName, input.role, unit).run();
  await recordEvent(db, { actor: input.actor, targetEmail: email, action: "user.created", previous: null, next });
  const created = await loadUser(db, email);
  if (!created) throw new UserDirectoryError("USER_NOT_FOUND", "Kullanıcı kaydı oluşturulamadı.", 500);
  return toDirectoryUser(created);
}

export type UpdateUserInput = {
  actor: string;
  email: unknown;
  displayName?: unknown;
  role?: unknown;
  unit?: unknown;
  active?: unknown;
  allowedUnits: readonly string[];
};

/** Rol, müdürlük kapsamı, ad ve erişim durumunu günceller. */
export async function updateUser(db: D1Database, input: UpdateUserInput): Promise<DirectoryUser> {
  const email = normalizeEmail(String(input.email ?? ""));
  const current = await loadUser(db, email);
  if (!current) throw new UserDirectoryError("USER_NOT_FOUND", "Kullanıcı bulunamadı.", 404);

  const previous = stateOf(current);
  const role = input.role === undefined ? current.role : (assertRole(input.role), input.role);
  const unit = input.unit === undefined ? current.unit : normalizeUnit(input.unit, input.allowedUnits);
  const active = input.active === undefined ? previous.active : Boolean(input.active);
  const displayName = normalizeDisplayName(input.displayName, current.display_name);
  const actor = normalizeEmail(input.actor);

  // Kaza koruması: yönetici kendi erişimini kapatamaz, kendi rolünü düşüremez.
  if (actor === email) {
    if (!active) {
      throw new UserDirectoryError("SELF_DEACTIVATION", "Kendi erişiminizi kapatamazsınız.", 409);
    }
    if (current.role === "admin" && role !== "admin") {
      throw new UserDirectoryError("SELF_DEMOTION", "Kendi yönetici rolünüzü düşüremezsiniz; devir başka bir yönetici tarafından yapılmalıdır.", 409);
    }
  }
  // Kilitlenme koruması: son aktif yönetici korunur.
  const losesAdmin = current.role === "admin" && current.active === 1 && (role !== "admin" || !active);
  if (losesAdmin && (await otherActiveAdminCount(db, email)) === 0) {
    throw new UserDirectoryError("LAST_ADMIN", "Sistemde en az bir aktif yönetici kalmalıdır.", 409);
  }

  const next: UserState = { role, unit, active };
  const unchanged = previous.role === role && previous.unit === unit && previous.active === active
    && current.display_name === displayName;
  if (unchanged) return toDirectoryUser(current);

  await db.prepare(`UPDATE archive_users SET display_name = ?, role = ?, unit = ?, active = ?,
      updated_at = CURRENT_TIMESTAMP WHERE email = ?`)
    .bind(displayName, role, unit, active ? 1 : 0, email).run();
  await recordEvent(db, { actor: input.actor, targetEmail: email, action: "user.updated", previous, next });
  const updated = await loadUser(db, email);
  if (!updated) throw new UserDirectoryError("USER_NOT_FOUND", "Kullanıcı kaydı okunamadı.", 500);
  return toDirectoryUser(updated);
}

/** Son yetki değişiklikleri; ekranda kimin neyi değiştirdiğini gösterir. */
export async function listUserAdminEvents(db: D1Database, limit = 20): Promise<UserAdminEvent[]> {
  const safeLimit = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 20, 1), 100);
  const result = await db.prepare(`SELECT id, actor, target_email, action, previous_state, new_state, created_at
    FROM user_admin_events ORDER BY created_at DESC, rowid DESC LIMIT ?`).bind(safeLimit)
    .all<{ id: string; actor: string; target_email: string; action: UserAdminEvent["action"];
      previous_state: string | null; new_state: string; created_at: string }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    actor: row.actor,
    targetEmail: row.target_email,
    action: row.action,
    previousState: row.previous_state ? JSON.parse(row.previous_state) as UserState : null,
    newState: JSON.parse(row.new_state) as UserState,
    createdAt: row.created_at,
  }));
}
