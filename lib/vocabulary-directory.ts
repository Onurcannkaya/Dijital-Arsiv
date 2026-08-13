/**
 * Kontrollü sözlük terimi yönetimi — ortak kurallar.
 *
 * Müdürlük listesi, ret gerekçeleri ve arkadan gelecek diğer kurum listeleri
 * aynı tabloda (`vocabulary_terms`) yaşar ve aynı iki kuralı paylaşır:
 *
 * 1. **Kaldırma değil, pasifleştirme.** Terim listeden çıkarıldığında kaydı
 *    silinmez; `active = 0` ile kapatılır. Geçmiş kayıtlar o değeri taşımaya
 *    devam eder — belgeler sahipsiz kalmaz, denetim izindeki ret gerekçesi
 *    okunabilir kalır. Yeni işlemlerde listede görünmez.
 * 2. **Son aktif terim korunur.** Liste tamamen boşalırsa o sözlüğe dayanan
 *    işlem yapılamaz hâle gelir: müdürlük yoksa belge yüklenemez, ret gerekçesi
 *    yoksa hiçbir ret kaydedilemez.
 *
 * Kurallar tek yerde durur; her sözlük için ayrı bir kopya yazmak bu iki
 * güvenceyi zamanla ayrıştırırdı.
 *
 * Her değişiklik yönetim denetim kaydına (`user_admin_events`) yazılır.
 */

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const MAX_LABEL = 120;

/** Terimin kaç kayıtta kullanıldığı; pasifleştirmeden önce gösterilir. */
export type TermUsage = { label: string; count: number };

export type DirectoryTerm = {
  code: string;
  label: string;
  active: boolean;
  sortOrder: number;
  usage: TermUsage[];
};

/**
 * Yönetilebilir bir sözlüğün tanımı.
 *
 * `usageCounts` pasifleştirme kararını bilgilendirir: kaç belge, kaç kullanıcı
 * ya da kaç ret kaydı o terime bağlı. Sözlüğe göre değiştiği için burada
 * sabitlenmez.
 */
export type ManagedVocabulary = {
  vocabularyCode: string;
  /** Denetim kaydındaki hedef türü (`user_admin_events.target_kind`). */
  targetKind: string;
  /** Denetim kaydındaki eylem adları. */
  actions: { created: string; updated: string };
  /*
   * Hata kodları da tanımdan gelir: çağıran taraf ve testler sözlüğün kendi
   * diliyle konuşur (`LAST_UNIT`, `LAST_REASON`), genel bir kodla değil.
   */
  errorCodes: { exists: string; notFound: string; lastActive: string };
  messages: {
    vocabularyMissing: string;
    invalidLabel: string;
    labelUnusable: string;
    exists: string;
    notFound: string;
    lastActive: string;
  };
  usageCounts?: (db: D1Database, term: { code: string; label: string }) => Promise<TermUsage[]>;
};

export class VocabularyDirectoryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "VocabularyDirectoryError";
    this.code = code;
    this.status = status;
  }
}

type TermRow = { id: string; code: string; label: string; active: number; sort_order: number };

async function vocabularyId(db: D1Database, vocabulary: ManagedVocabulary): Promise<string> {
  const row = await db.prepare("SELECT id FROM vocabularies WHERE code = ?")
    .bind(vocabulary.vocabularyCode).first<{ id: string }>();
  if (!row) throw new VocabularyDirectoryError("VOCABULARY_MISSING", vocabulary.messages.vocabularyMissing, 409);
  return row.id;
}

export async function listTerms(db: D1Database, vocabulary: ManagedVocabulary): Promise<DirectoryTerm[]> {
  const result = await db.prepare(`SELECT t.id, t.code, t.label, t.active, t.sort_order
    FROM vocabulary_terms t INNER JOIN vocabularies v ON v.id = t.vocabulary_id
    WHERE v.code = ? ORDER BY t.active DESC, t.sort_order, t.label`)
    .bind(vocabulary.vocabularyCode).all<TermRow>();
  return Promise.all((result.results ?? []).map(async (row) => ({
    code: row.code,
    label: row.label,
    active: row.active === 1,
    sortOrder: Number(row.sort_order),
    usage: await vocabulary.usageCounts?.(db, { code: row.code, label: row.label }) ?? [],
  })));
}

async function recordEvent(
  db: D1Database,
  vocabulary: ManagedVocabulary,
  input: { actor: string; code: string; action: string;
    previous: { label: string; active: boolean } | null; next: { label: string; active: boolean } },
) {
  await db.prepare(`INSERT INTO user_admin_events
      (id, actor, target_email, target_kind, action, previous_state, new_state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.actor, input.code, vocabulary.targetKind, input.action,
      input.previous ? JSON.stringify(input.previous) : null,
      JSON.stringify(input.next), new Date().toISOString()).run();
}

/** Etiketten güvenli, sabit bir sözlük kodu üretir (Türkçe harfler sadeleştirilir). */
export function termCodeFromLabel(label: string): string {
  const map: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };
  const ascii = label.toLocaleLowerCase("tr").replace(/[çğıöşü]/g, (char) => map[char] ?? char);
  return ascii.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase().slice(0, 64);
}

export async function createTerm(
  db: D1Database,
  vocabulary: ManagedVocabulary,
  input: { actor: string; label: unknown },
): Promise<DirectoryTerm> {
  const label = String(input.label ?? "").trim().replace(/\s+/g, " ");
  if (!label || label.length > MAX_LABEL) {
    throw new VocabularyDirectoryError("INVALID_LABEL", vocabulary.messages.invalidLabel);
  }
  const code = termCodeFromLabel(label);
  if (!CODE_PATTERN.test(code)) {
    throw new VocabularyDirectoryError("INVALID_LABEL", vocabulary.messages.labelUnusable);
  }
  const id = await vocabularyId(db, vocabulary);
  const existing = await db.prepare(`SELECT code FROM vocabulary_terms
    WHERE vocabulary_id = ? AND (code = ? OR label = ?)`).bind(id, code, label).first<{ code: string }>();
  if (existing) throw new VocabularyDirectoryError(vocabulary.errorCodes.exists, vocabulary.messages.exists, 409);

  const order = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM vocabulary_terms WHERE vocabulary_id = ?")
    .bind(id).first<{ next: number }>();
  await db.prepare(`INSERT INTO vocabulary_terms (id, vocabulary_id, code, label, sort_order, active)
    VALUES (?, ?, ?, ?, ?, 1)`)
    .bind(crypto.randomUUID(), id, code, label, Number(order?.next ?? 1)).run();
  await recordEvent(db, vocabulary, {
    actor: input.actor, code, action: vocabulary.actions.created,
    previous: null, next: { label, active: true },
  });

  const created = (await listTerms(db, vocabulary)).find((term) => term.code === code);
  if (!created) throw new VocabularyDirectoryError(vocabulary.errorCodes.notFound, vocabulary.messages.notFound, 500);
  return created;
}

/** Terimi pasifleştirir ya da yeniden etkinleştirir; kayıt silinmez. */
export async function setTermActive(
  db: D1Database,
  vocabulary: ManagedVocabulary,
  input: { actor: string; code: unknown; active: unknown },
): Promise<DirectoryTerm> {
  const code = String(input.code ?? "").trim();
  const active = Boolean(input.active);
  const id = await vocabularyId(db, vocabulary);
  const current = await db.prepare(`SELECT id, code, label, active FROM vocabulary_terms
    WHERE vocabulary_id = ? AND code = ?`).bind(id, code)
    .first<{ id: string; code: string; label: string; active: number }>();
  if (!current) throw new VocabularyDirectoryError(vocabulary.errorCodes.notFound, vocabulary.messages.notFound, 404);

  // Durum zaten istenen durumdaysa denetim kaydı yazılmaz: olmamış bir yönetim
  // kararı ize girmemelidir.
  if ((current.active === 1) === active) {
    const unchanged = (await listTerms(db, vocabulary)).find((term) => term.code === code);
    if (!unchanged) throw new VocabularyDirectoryError(vocabulary.errorCodes.notFound, vocabulary.messages.notFound, 500);
    return unchanged;
  }

  if (!active) {
    const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM vocabulary_terms
      WHERE vocabulary_id = ? AND active = 1 AND code <> ?`).bind(id, code).first<{ count: number }>();
    if (Number(remaining?.count ?? 0) === 0) {
      throw new VocabularyDirectoryError(vocabulary.errorCodes.lastActive, vocabulary.messages.lastActive, 409);
    }
  }

  await db.prepare("UPDATE vocabulary_terms SET active = ? WHERE id = ?").bind(active ? 1 : 0, current.id).run();
  await recordEvent(db, vocabulary, {
    actor: input.actor, code, action: vocabulary.actions.updated,
    previous: { label: current.label, active: current.active === 1 },
    next: { label: current.label, active },
  });

  const updated = (await listTerms(db, vocabulary)).find((term) => term.code === code);
  if (!updated) throw new VocabularyDirectoryError(vocabulary.errorCodes.notFound, vocabulary.messages.notFound, 500);
  return updated;
}
