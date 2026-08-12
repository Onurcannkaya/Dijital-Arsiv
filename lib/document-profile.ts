/**
 * Belge türü profillerinin veritabanından yüklenmesi.
 *
 * Kaynak sözleşme: VERI_SOZLUGU.md §6 (belge türü ve alan profili), §13
 * (kontrollü sözlükler), ADR-008 (müdürlük farkları sürümlü profillerle yönetilir).
 *
 * Bu modül kural **taşımaz**, kural **okur**. Alan çokluğu, kritiklik,
 * zorunluluk, biçim ve sözlük bağı `field_definitions` tablosundan gelir;
 * değerlendirme mantığı `lib/field-policy.ts` içindedir.
 */

import { DEFAULT_DOCUMENT_TYPE_CODE } from "./archive-seed.ts";

export type Cardinality = "one" | "zero_or_one" | "one_or_more" | "many";
export type Requirement = "OPTIONAL" | "REQUIRED" | "REQUIRED_FOR_ARCHIVE";
export type ExtractionPolicy = "NONE" | "SUGGEST" | "VERIFY_REQUIRED";
export type ProfileStatus = "HYPOTHESIS" | "DISCOVERED" | "VALIDATED" | "PILOT" | "ACTIVE" | "RETIRED";

export type FieldDefinition = {
  id: string;
  fieldCode: string;
  label: string;
  dataType: string;
  cardinality: Cardinality;
  requirement: Requirement;
  isCritical: boolean;
  extractionPolicy: ExtractionPolicy;
  formatPattern: string | null;
  formatHint: string | null;
  vocabularyCode: string | null;
  enforceVocabulary: boolean;
  entityType: string | null;
  sortOrder: number;
};

export type DocumentProfile = {
  documentTypeId: string;
  code: string;
  name: string;
  ownerDepartment: string;
  profileVersion: string;
  profileStatus: ProfileStatus;
  detectionMarkers: string[];
  fields: FieldDefinition[];
  /** Alan kodundan tanıma hızlı erişim. */
  byCode: Map<string, FieldDefinition>;
};

type TypeRow = {
  id: string; code: string; name: string; owner_department: string;
  profile_version: string; profile_status: ProfileStatus; detection_markers_json: string;
};
type FieldRow = {
  id: string; field_code: string; label: string; data_type: string; cardinality: Cardinality;
  requirement: Requirement; is_critical: number; extraction_policy: ExtractionPolicy;
  format_pattern: string | null; format_hint: string | null; vocabulary_code: string | null;
  enforce_vocabulary: number; entity_type: string | null; sort_order: number;
};

/**
 * İzolasyon ömrü boyunca kısa süreli önbellek.
 *
 * Profiller nadiren değişir; her istekte iki sorgu yapmamak için 60 saniyelik
 * bayatlığa izin verilir. Profil yönetim arayüzü eklendiğinde bu önbelleğin
 * açıkça temizlenmesi gerekir (`clearProfileCache`).
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; profile: DocumentProfile }>();

export function clearProfileCache() {
  cache.clear();
}

function toProfile(type: TypeRow, fields: FieldRow[]): DocumentProfile {
  const mapped = fields.map((row) => ({
    id: row.id,
    fieldCode: row.field_code,
    label: row.label,
    dataType: row.data_type,
    cardinality: row.cardinality,
    requirement: row.requirement,
    isCritical: Boolean(row.is_critical),
    extractionPolicy: row.extraction_policy,
    formatPattern: row.format_pattern,
    formatHint: row.format_hint,
    vocabularyCode: row.vocabulary_code,
    enforceVocabulary: Boolean(row.enforce_vocabulary),
    entityType: row.entity_type,
    sortOrder: row.sort_order,
  }));
  let detectionMarkers: string[] = [];
  try {
    const parsed = JSON.parse(type.detection_markers_json) as unknown;
    if (Array.isArray(parsed)) detectionMarkers = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch { /* Bozuk işaret listesi tanımayı kapatır, hata üretmez. */ }
  return {
    documentTypeId: type.id,
    code: type.code,
    name: type.name,
    ownerDepartment: type.owner_department,
    profileVersion: type.profile_version,
    profileStatus: type.profile_status,
    detectionMarkers,
    fields: mapped,
    byCode: new Map(mapped.map((field) => [field.fieldCode, field])),
  };
}

const typeSelect = `SELECT id, code, name, owner_department, profile_version, profile_status, detection_markers_json
  FROM document_types`;

async function loadFields(db: D1Database, documentTypeId: string) {
  const result = await db.prepare(`SELECT id, field_code, label, data_type, cardinality, requirement,
    is_critical, extraction_policy, format_pattern, format_hint, vocabulary_code, enforce_vocabulary,
    entity_type, sort_order FROM field_definitions WHERE document_type_id = ? ORDER BY sort_order, field_code`)
    .bind(documentTypeId).all<FieldRow>();
  return result.results;
}

async function fromRow(db: D1Database, row: TypeRow, cacheKey: string) {
  const profile = toProfile(row, await loadFields(db, row.id));
  cache.set(cacheKey, { at: Date.now(), profile });
  return profile;
}

/** Yalnız yürürlükteki (kapatılmamış) en yüksek sürümlü profili döndürür. */
async function loadByIdentity(db: D1Database, column: "id" | "name" | "code", value: string) {
  const cacheKey = `${column}:${value}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.profile;
  const where = column === "id"
    ? "WHERE id = ?"
    : `WHERE ${column} = ? AND valid_to IS NULL ORDER BY profile_version DESC LIMIT 1`;
  const row = await db.prepare(`${typeSelect} ${where}`).bind(value).first<TypeRow>();
  return row ? await fromRow(db, row, cacheKey) : null;
}

/**
 * Belgenin profilini çözer.
 *
 * Sıra: kayıtlı profil kimliği → belge türü adı (eski serbest metin kayıtlar) →
 * varsayılan `TASNIF_BEKLIYOR` profili. Böylece profil kaydı olmayan tarihsel
 * belgeler de en az ortak çekirdek kurallarıyla değerlendirilir.
 */
export async function resolveDocumentProfile(
  db: D1Database,
  document: { documentTypeId?: string | null; documentType?: string | null },
): Promise<DocumentProfile> {
  if (document.documentTypeId) {
    const byId = await loadByIdentity(db, "id", document.documentTypeId);
    if (byId) return byId;
  }
  if (document.documentType) {
    const byName = await loadByIdentity(db, "name", document.documentType);
    if (byName) return byName;
  }
  const fallback = await loadByIdentity(db, "code", DEFAULT_DOCUMENT_TYPE_CODE);
  if (!fallback) throw new Error("Varsayılan belge türü profili bulunamadı; şema tohumlaması eksik.");
  return fallback;
}

export async function loadProfileByCode(db: D1Database, code: string) {
  return await loadByIdentity(db, "code", code);
}

/**
 * Görünen ada göre tam eşleşme. Varsayılan profile düşmez: çağıran "bilinmeyen
 * belge türü" durumunu ayırt edebilir, böylece tasnif sessizce sıfırlanmaz.
 */
export async function loadProfileByName(db: D1Database, name: string) {
  return await loadByIdentity(db, "name", name);
}

/** Yürürlükteki bütün profiller — yükleme ekranı ve profil listesi için. */
export async function listActiveProfiles(db: D1Database) {
  const result = await db.prepare(`${typeSelect} WHERE valid_to IS NULL ORDER BY name`).all<TypeRow>();
  return await Promise.all(result.results.map(async (row) => toProfile(row, await loadFields(db, row.id))));
}

export type VocabularyTerm = { code: string; label: string };

/**
 * Kontrollü sözlük terimleri. Sözlük yoksa veya boşsa `null` döner; çağıran
 * "sözlük tanımlı değil" ile "sözlükte yok" durumunu ayırt edebilir.
 */
export async function loadVocabularyTerms(db: D1Database, vocabularyCode: string): Promise<VocabularyTerm[] | null> {
  const result = await db.prepare(`SELECT t.code, t.label FROM vocabulary_terms t
    INNER JOIN vocabularies v ON v.id = t.vocabulary_id
    WHERE v.code = ? AND t.active = 1 AND (t.valid_to IS NULL OR t.valid_to > date('now'))
    ORDER BY t.sort_order, t.label`).bind(vocabularyCode).all<VocabularyTerm>();
  return result.results.length ? result.results : null;
}

export async function loadVocabularyVersion(db: D1Database, vocabularyCode: string) {
  const row = await db.prepare("SELECT version FROM vocabularies WHERE code = ?").bind(vocabularyCode).first<{ version: string }>();
  return row?.version ?? null;
}
