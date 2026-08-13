/**
 * Müdürlük (kontrollü sözlük) yönetimi.
 *
 * Müdürlük listesi yalnız bir açılır liste değildir: kullanıcıların erişim
 * kapsamı (`archive_users.unit`) ve belgelerin sahipliği (`archive_documents.unit`)
 * bu değerlere dayanır. Bu yüzden kaldırma yerine pasifleştirme uygulanır ve
 * son aktif müdürlük korunur — kurallar `vocabulary-directory.ts` içindedir ve
 * ret gerekçesi sözlükleriyle paylaşılır; burası yalnız müdürlüğe özgü
 * tanımdır.
 *
 * Her değişiklik yönetim denetim kaydına (`user_admin_events`, hedef türü
 * `unit`) yazılır.
 */

import {
  type DirectoryTerm, type ManagedVocabulary, VocabularyDirectoryError,
  createTerm, listTerms, setTermActive, termCodeFromLabel,
} from "./vocabulary-directory.ts";

export { VocabularyDirectoryError as UnitDirectoryError };

export type DirectoryUnit = {
  code: string;
  label: string;
  active: boolean;
  sortOrder: number;
  /** Bu müdürlüğe bağlı belge ve kullanıcı sayısı; pasifleştirme uyarısı için. */
  documentCount: number;
  userCount: number;
};

/** Etiketten güvenli, sabit bir sözlük kodu üretir (Türkçe harfler sadeleştirilir). */
export const unitCodeFromLabel = termCodeFromLabel;

function unitVocabulary(vocabularyCode: string): ManagedVocabulary {
  return {
    vocabularyCode,
    targetKind: "unit",
    actions: { created: "unit.created", updated: "unit.updated" },
    errorCodes: { exists: "UNIT_EXISTS", notFound: "UNIT_NOT_FOUND", lastActive: "LAST_UNIT" },
    messages: {
      vocabularyMissing: "Müdürlük sözlüğü kurulu değil.",
      invalidLabel: "Müdürlük adı 1 ile 120 karakter arasında olmalıdır.",
      labelUnusable: "Müdürlük adından geçerli bir kod üretilemedi.",
      exists: "Bu müdürlük zaten tanımlı.",
      notFound: "Müdürlük bulunamadı.",
      lastActive: "Listede en az bir aktif müdürlük kalmalıdır.",
    },
    // Pasifleştirme uyarısı: kaç belge ve kaç kullanıcı bu müdürlüğe bağlı.
    usageCounts: async (db, term) => {
      const row = await db.prepare(`SELECT
          (SELECT COUNT(*) FROM archive_documents d WHERE d.unit = ?) AS document_count,
          (SELECT COUNT(*) FROM archive_users u WHERE u.unit = ?) AS user_count`)
        .bind(term.label, term.label).first<{ document_count: number; user_count: number }>();
      return [
        { label: "belge", count: Number(row?.document_count ?? 0) },
        { label: "kullanıcı", count: Number(row?.user_count ?? 0) },
      ];
    },
  };
}

function toUnit(term: DirectoryTerm): DirectoryUnit {
  const count = (label: string) => term.usage.find((entry) => entry.label === label)?.count ?? 0;
  return {
    code: term.code,
    label: term.label,
    active: term.active,
    sortOrder: term.sortOrder,
    documentCount: count("belge"),
    userCount: count("kullanıcı"),
  };
}

export async function listUnits(db: D1Database, vocabularyCode: string): Promise<DirectoryUnit[]> {
  return (await listTerms(db, unitVocabulary(vocabularyCode))).map(toUnit);
}

export type CreateUnitInput = { actor: string; label: unknown; vocabularyCode: string };

export async function createUnit(db: D1Database, input: CreateUnitInput): Promise<DirectoryUnit> {
  return toUnit(await createTerm(db, unitVocabulary(input.vocabularyCode),
    { actor: input.actor, label: input.label }));
}

export type UpdateUnitInput = { actor: string; code: unknown; active: unknown; vocabularyCode: string };

/** Müdürlüğü pasifleştirir ya da yeniden etkinleştirir; kayıt silinmez. */
export async function setUnitActive(db: D1Database, input: UpdateUnitInput): Promise<DirectoryUnit> {
  return toUnit(await setTermActive(db, unitVocabulary(input.vocabularyCode),
    { actor: input.actor, code: input.code, active: input.active }));
}
