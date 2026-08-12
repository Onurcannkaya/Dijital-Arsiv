/**
 * Müdürlük (kontrollü sözlük) yönetimi.
 *
 * Müdürlük listesi yalnız bir açılır liste değildir: kullanıcıların erişim
 * kapsamı (`archive_users.unit`) ve belgelerin sahipliği (`archive_documents.unit`)
 * bu değerlere dayanır. Bu yüzden iki kural zorlanır:
 *
 * 1. **Kaldırma değil, pasifleştirme.** Bir müdürlük listeden çıkarıldığında
 *    kaydı silinmez; `active = 0` ile kapatılır. Geçmiş belgeler ve kullanıcılar
 *    o değeri taşımaya devam eder — kayıt sahipsiz kalmaz ve denetim izi
 *    okunabilir kalır. Yeni yükleme ve yetki atamalarında listede görünmez.
 * 2. **Son aktif müdürlük korunur.** Liste tamamen boşalırsa belge yüklemesi
 *    ve müdürlük kapsamı ataması yapılamaz hâle gelir.
 *
 * Her değişiklik yönetim denetim kaydına (`user_admin_events`, hedef türü
 * `unit`) yazılır.
 */

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const MAX_LABEL = 120;

export type DirectoryUnit = {
  code: string;
  label: string;
  active: boolean;
  sortOrder: number;
  /** Bu müdürlüğe bağlı belge ve kullanıcı sayısı; pasifleştirme uyarısı için. */
  documentCount: number;
  userCount: number;
};

export class UnitDirectoryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "UnitDirectoryError";
    this.code = code;
    this.status = status;
  }
}

type UnitRow = {
  id: string;
  code: string;
  label: string;
  active: number;
  sort_order: number;
  document_count: number;
  user_count: number;
};

async function vocabularyId(db: D1Database, vocabularyCode: string): Promise<string> {
  const row = await db.prepare("SELECT id FROM vocabularies WHERE code = ?").bind(vocabularyCode).first<{ id: string }>();
  if (!row) throw new UnitDirectoryError("VOCABULARY_MISSING", "Müdürlük sözlüğü kurulu değil.", 409);
  return row.id;
}

export async function listUnits(db: D1Database, vocabularyCode: string): Promise<DirectoryUnit[]> {
  const result = await db.prepare(`SELECT t.id, t.code, t.label, t.active, t.sort_order,
      (SELECT COUNT(*) FROM archive_documents d WHERE d.unit = t.label) AS document_count,
      (SELECT COUNT(*) FROM archive_users u WHERE u.unit = t.label) AS user_count
    FROM vocabulary_terms t INNER JOIN vocabularies v ON v.id = t.vocabulary_id
    WHERE v.code = ? ORDER BY t.active DESC, t.sort_order, t.label`)
    .bind(vocabularyCode).all<UnitRow>();
  return (result.results ?? []).map((row) => ({
    code: row.code,
    label: row.label,
    active: row.active === 1,
    sortOrder: Number(row.sort_order),
    documentCount: Number(row.document_count),
    userCount: Number(row.user_count),
  }));
}

async function recordUnitEvent(
  db: D1Database,
  input: { actor: string; code: string; action: "unit.created" | "unit.updated";
    previous: { label: string; active: boolean } | null; next: { label: string; active: boolean } },
) {
  await db.prepare(`INSERT INTO user_admin_events
      (id, actor, target_email, target_kind, action, previous_state, new_state, created_at)
    VALUES (?, ?, ?, 'unit', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.actor, input.code, input.action,
      input.previous ? JSON.stringify(input.previous) : null,
      JSON.stringify(input.next), new Date().toISOString()).run();
}

/** Etiketten güvenli, sabit bir sözlük kodu üretir (Türkçe harfler sadeleştirilir). */
export function unitCodeFromLabel(label: string): string {
  const map: Record<string, string> = { ç:"c", ğ:"g", ı:"i", ö:"o", ş:"s", ü:"u" };
  const ascii = label.toLocaleLowerCase("tr").replace(/[çğıöşü]/g, (char) => map[char] ?? char);
  return ascii.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase().slice(0, 64);
}

export type CreateUnitInput = { actor: string; label: unknown; vocabularyCode: string };

export async function createUnit(db: D1Database, input: CreateUnitInput): Promise<DirectoryUnit> {
  const label = String(input.label ?? "").trim().replace(/\s+/g, " ");
  if (!label || label.length > MAX_LABEL) {
    throw new UnitDirectoryError("INVALID_LABEL", "Müdürlük adı 1 ile 120 karakter arasında olmalıdır.");
  }
  const code = unitCodeFromLabel(label);
  if (!CODE_PATTERN.test(code)) {
    throw new UnitDirectoryError("INVALID_LABEL", "Müdürlük adından geçerli bir kod üretilemedi.");
  }
  const vocabulary = await vocabularyId(db, input.vocabularyCode);
  const existing = await db.prepare(`SELECT code FROM vocabulary_terms
    WHERE vocabulary_id = ? AND (code = ? OR label = ?)`).bind(vocabulary, code, label).first<{ code: string }>();
  if (existing) throw new UnitDirectoryError("UNIT_EXISTS", "Bu müdürlük zaten tanımlı.", 409);

  const order = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM vocabulary_terms WHERE vocabulary_id = ?")
    .bind(vocabulary).first<{ next: number }>();
  await db.prepare(`INSERT INTO vocabulary_terms (id, vocabulary_id, code, label, sort_order, active)
    VALUES (?, ?, ?, ?, ?, 1)`)
    .bind(crypto.randomUUID(), vocabulary, code, label, Number(order?.next ?? 1)).run();
  await recordUnitEvent(db, { actor: input.actor, code, action: "unit.created", previous: null, next: { label, active: true } });

  const created = (await listUnits(db, input.vocabularyCode)).find((unit) => unit.code === code);
  if (!created) throw new UnitDirectoryError("UNIT_NOT_FOUND", "Müdürlük kaydı oluşturulamadı.", 500);
  return created;
}

export type UpdateUnitInput = { actor: string; code: unknown; active: unknown; vocabularyCode: string };

/** Müdürlüğü pasifleştirir ya da yeniden etkinleştirir; kayıt silinmez. */
export async function setUnitActive(db: D1Database, input: UpdateUnitInput): Promise<DirectoryUnit> {
  const code = String(input.code ?? "").trim();
  const active = Boolean(input.active);
  const vocabulary = await vocabularyId(db, input.vocabularyCode);
  const current = await db.prepare(`SELECT id, code, label, active FROM vocabulary_terms
    WHERE vocabulary_id = ? AND code = ?`).bind(vocabulary, code)
    .first<{ id: string; code: string; label: string; active: number }>();
  if (!current) throw new UnitDirectoryError("UNIT_NOT_FOUND", "Müdürlük bulunamadı.", 404);
  if ((current.active === 1) === active) {
    const unchanged = (await listUnits(db, input.vocabularyCode)).find((unit) => unit.code === code);
    if (!unchanged) throw new UnitDirectoryError("UNIT_NOT_FOUND", "Müdürlük okunamadı.", 500);
    return unchanged;
  }

  if (!active) {
    const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM vocabulary_terms
      WHERE vocabulary_id = ? AND active = 1 AND code <> ?`).bind(vocabulary, code).first<{ count: number }>();
    if (Number(remaining?.count ?? 0) === 0) {
      throw new UnitDirectoryError("LAST_UNIT", "Listede en az bir aktif müdürlük kalmalıdır.", 409);
    }
  }

  await db.prepare("UPDATE vocabulary_terms SET active = ? WHERE id = ?")
    .bind(active ? 1 : 0, current.id).run();
  await recordUnitEvent(db, {
    actor: input.actor, code, action: "unit.updated",
    previous: { label: current.label, active: current.active === 1 },
    next: { label: current.label, active },
  });

  const updated = (await listUnits(db, input.vocabularyCode)).find((unit) => unit.code === code);
  if (!updated) throw new UnitDirectoryError("UNIT_NOT_FOUND", "Müdürlük okunamadı.", 500);
  return updated;
}
