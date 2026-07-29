/**
 * Arşiv veritabanı şeması — çalışma zamanı kaynağı.
 *
 * `db/schema.ts` (Drizzle) tip üretimi ve `drizzle/` göç dosyaları için aynı
 * yapıyı ikinci kez tanımlar; iki tanım `tests/schema-contract.test.mjs` ile
 * karşılaştırılır. Yol haritası maddesi 12'de tek kaynağa indirilecektir.
 *
 * Sürüm kapısı: `schema_state.version` güncel olduğunda tüm DDL atlanır, böylece
 * her istek onlarca `CREATE TABLE IF NOT EXISTS` çalıştırmaz.
 */

import {
  DEFAULT_DOCUMENT_TYPE_CODE, SEED_PROFILE_VERSION, extractionPolicyFor,
  seedDocumentTypes, seedFieldsFor, seedVocabularies,
} from "./archive-seed";

export { DEFAULT_DOCUMENT_TYPE_CODE };

/**
 * Şema sürümü. Tablo, indeks veya kolon eklendiğinde **her zaman** artırılır ve
 * `migrations` listesine karşılık gelen adım eklenir.
 *
 * Göç adımları sürüme göre planlanır, kolon yokluğuna göre değil: bir adım
 * çalıştıktan sonra aynı tabloya yeni kolon eklenirse, kolon sniffing yapan bir
 * kapı adımı bir daha çalıştırmaz ve şema sessizce eksik kalır.
 */
export const ARCHIVE_SCHEMA_VERSION = 4;

/**
 * Bağımlılık sırasına göre tablo ve indeks tanımları.
 *
 * `archive_documents` üzerindeki `storage_key`/`sha256`/`byte_size`/`media_type`
 * kolonları kabul alındısıdır (VERI_SOZLUGU.md §5) ve tekrar kontrolünü besler;
 * nesne kayıtlarının yetkili listesi `binary_objects` tablosudur.
 */
const tableStatements: string[] = [
  `CREATE TABLE IF NOT EXISTS archive_documents (
    id TEXT PRIMARY KEY NOT NULL,
    reference_no TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    document_type TEXT NOT NULL DEFAULT 'Tasnif bekliyor',
    document_type_id TEXT REFERENCES document_types(id),
    document_profile_version TEXT,
    unit TEXT NOT NULL DEFAULT 'Belirlenmedi',
    status TEXT NOT NULL DEFAULT 'queued',
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS archive_documents_sha256_unique ON archive_documents (sha256)",
  "CREATE INDEX IF NOT EXISTS archive_documents_profile_idx ON archive_documents (document_type_id)",
  "CREATE INDEX IF NOT EXISTS archive_documents_status_idx ON archive_documents (status)",
  "CREATE INDEX IF NOT EXISTS archive_documents_created_at_idx ON archive_documents (created_at)",

  // S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5 ve §8: nesne sınıfları ve nesne kaydı.
  `CREATE TABLE IF NOT EXISTS binary_objects (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    object_class TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    storage_provider TEXT NOT NULL DEFAULT 'r2',
    bucket_or_namespace TEXT NOT NULL DEFAULT 'ARCHIVE_FILES',
    storage_version_id TEXT,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    encryption_status TEXT NOT NULL DEFAULT 'provider-managed',
    derived_from_id TEXT REFERENCES binary_objects(id),
    generator TEXT,
    retention_status TEXT NOT NULL DEFAULT 'ACTIVE',
    legal_hold_status TEXT NOT NULL DEFAULT 'NONE',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (object_class IN ('original', 'access', 'ocr', 'preservation', 'thumbnail', 'quarantine', 'temporary')),
    CHECK (retention_status IN ('ACTIVE', 'RETENTION_REVIEW', 'DISPOSED')),
    CHECK (legal_hold_status IN ('NONE', 'HELD')),
    CHECK (byte_size >= 0),
    CHECK (id <> derived_from_id)
  )`,
  "CREATE INDEX IF NOT EXISTS binary_objects_document_class_idx ON binary_objects (document_id, object_class)",
  "CREATE INDEX IF NOT EXISTS binary_objects_sha256_idx ON binary_objects (sha256)",
  // Bir belgenin yalnız bir asıl nesnesi olabilir; türevler serbesttir.
  "CREATE UNIQUE INDEX IF NOT EXISTS binary_objects_single_original_unique ON binary_objects (document_id) WHERE object_class = 'original'",

  `CREATE TABLE IF NOT EXISTS processing_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'ocr',
    status TEXT NOT NULL DEFAULT 'queued',
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    model TEXT NOT NULL DEFAULT 'paddleocr-local',
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS processing_jobs_status_created_idx ON processing_jobs (status, created_at)",
  "CREATE INDEX IF NOT EXISTS processing_jobs_document_idx ON processing_jobs (document_id)",

  `CREATE TABLE IF NOT EXISTS ocr_pages (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    raw_text TEXT NOT NULL DEFAULT '',
    full_text TEXT NOT NULL DEFAULT '',
    search_text TEXT NOT NULL DEFAULT '',
    confirmed_text TEXT,
    confirmed_by TEXT,
    confirmed_at TEXT,
    words_json TEXT NOT NULL DEFAULT '[]',
    average_confidence REAL NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS ocr_pages_document_page_unique ON ocr_pages (document_id, page_number)",
  "CREATE INDEX IF NOT EXISTS ocr_pages_document_idx ON ocr_pages (document_id)",

  `CREATE TABLE IF NOT EXISTS text_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    revision_number INTEGER NOT NULL,
    previous_sha256 TEXT NOT NULL,
    text_sha256 TEXT NOT NULL,
    revised_text TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS text_revisions_document_page_revision_unique ON text_revisions (document_id, page_number, revision_number)",
  "CREATE INDEX IF NOT EXISTS text_revisions_document_created_idx ON text_revisions (document_id, created_at)",

  // VERI_SOZLUGU.md §8: aynı belge ve alan için birden fazla değer bulunabilir.
  // Sıra `value_index` ile korunur; kimlik `id` üzerinden verilir.
  `CREATE TABLE IF NOT EXISTS extracted_fields (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    field_definition_id TEXT REFERENCES field_definitions(id),
    value_index INTEGER NOT NULL DEFAULT 0,
    field_value TEXT NOT NULL,
    normalized_value TEXT,
    confidence REAL NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'MEDIUM',
    page_number INTEGER NOT NULL,
    bbox_json TEXT NOT NULL,
    evidence_text TEXT NOT NULL,
    model TEXT NOT NULL,
    vocabulary_version TEXT,
    verification_status TEXT NOT NULL DEFAULT 'SUGGESTED',
    origin TEXT NOT NULL DEFAULT 'OCR',
    verified_by TEXT,
    verified_at TEXT,
    corrected_value TEXT,
    corrected_by TEXT,
    corrected_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (verification_status IN ('SUGGESTED', 'CONFIRMED', 'CORRECTED', 'REJECTED')),
    CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    CHECK (origin IN ('OCR', 'HUMAN')),
    CHECK (value_index >= 0)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS extracted_fields_document_field_value_unique ON extracted_fields (document_id, field_name, value_index)",
  "CREATE INDEX IF NOT EXISTS extracted_fields_document_idx ON extracted_fields (document_id)",
  "CREATE INDEX IF NOT EXISTS extracted_fields_status_idx ON extracted_fields (verification_status)",

  // VERI_SOZLUGU.md §13: kontrollü sözlükler. Her sözlük kaydı kod, görünen ad,
  // sürüm, geçerlilik tarihi, sahip ve kaynak bilgisi taşır.
  `CREATE TABLE IF NOT EXISTS vocabularies (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    source TEXT NOT NULL,
    version TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS vocabulary_terms (
    id TEXT PRIMARY KEY NOT NULL,
    vocabulary_id TEXT NOT NULL REFERENCES vocabularies(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    valid_from TEXT,
    valid_to TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (active IN (0, 1))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS vocabulary_terms_code_unique ON vocabulary_terms (vocabulary_id, code)",
  "CREATE INDEX IF NOT EXISTS vocabulary_terms_active_idx ON vocabulary_terms (vocabulary_id, active, sort_order)",

  // VERI_SOZLUGU.md §6 ve ADR-008: müdürlük farkları kod dallarıyla değil
  // sürümlü belge türü profilleriyle yönetilir. Eski profil silinmez; `valid_to`
  // ile kapatılır ve yeni sürüm eklenir.
  `CREATE TABLE IF NOT EXISTS document_types (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_department TEXT NOT NULL DEFAULT 'Belirlenmedi',
    profile_version TEXT NOT NULL,
    profile_status TEXT NOT NULL DEFAULT 'HYPOTHESIS',
    detection_markers_json TEXT NOT NULL DEFAULT '[]',
    valid_from TEXT,
    valid_to TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (profile_status IN ('HYPOTHESIS', 'DISCOVERED', 'VALIDATED', 'PILOT', 'ACTIVE', 'RETIRED'))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS document_types_code_version_unique ON document_types (code, profile_version)",
  "CREATE INDEX IF NOT EXISTS document_types_name_idx ON document_types (name)",
  "CREATE INDEX IF NOT EXISTS document_types_status_idx ON document_types (profile_status)",

  // Alan tanımları profil sürümüne bağlıdır: aynı alanın kuralı belge türüne ve
  // sürüme göre farklı olabilir.
  `CREATE TABLE IF NOT EXISTS field_definitions (
    id TEXT PRIMARY KEY NOT NULL,
    document_type_id TEXT NOT NULL REFERENCES document_types(id) ON DELETE CASCADE,
    field_code TEXT NOT NULL,
    label TEXT NOT NULL,
    data_type TEXT NOT NULL DEFAULT 'TEXT',
    cardinality TEXT NOT NULL DEFAULT 'one',
    requirement TEXT NOT NULL DEFAULT 'OPTIONAL',
    is_critical INTEGER NOT NULL DEFAULT 0,
    extraction_policy TEXT NOT NULL DEFAULT 'SUGGEST',
    format_pattern TEXT,
    format_hint TEXT,
    vocabulary_code TEXT,
    enforce_vocabulary INTEGER NOT NULL DEFAULT 0,
    entity_type TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (data_type IN ('TEXT', 'DATE', 'IDENTIFIER', 'CODE', 'ENTITY_REF')),
    CHECK (cardinality IN ('one', 'zero_or_one', 'one_or_more', 'many')),
    CHECK (requirement IN ('OPTIONAL', 'REQUIRED', 'REQUIRED_FOR_ARCHIVE')),
    CHECK (extraction_policy IN ('NONE', 'SUGGEST', 'VERIFY_REQUIRED')),
    CHECK (is_critical IN (0, 1)),
    CHECK (enforce_vocabulary IN (0, 1)),
    -- ADR-006: kritik alanda insan onayı her durumda zorunludur.
    CHECK (is_critical = 0 OR extraction_policy = 'VERIFY_REQUIRED'),
    CHECK (length(format_pattern) <= 400)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS field_definitions_type_code_unique ON field_definitions (document_type_id, field_code)",
  "CREATE INDEX IF NOT EXISTS field_definitions_type_order_idx ON field_definitions (document_type_id, sort_order)",

  // VERI_SOZLUGU.md §9: ortak varlık çekirdeği.
  // `PERSON` ve `ORGANIZATION` türleri hukuk/KVKK veri envanteri tamamlanana
  // kadar bilinçli olarak dışarıda tutulmuştur (VERI_SOZLUGU.md §9 sonu).
  `CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL,
    display_label TEXT NOT NULL,
    authority_source TEXT NOT NULL DEFAULT 'ARCHIVE',
    external_id TEXT,
    entity_status TEXT NOT NULL DEFAULT 'PROVISIONAL',
    merged_into_id TEXT REFERENCES entities(id),
    valid_from TEXT,
    valid_to TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (entity_type IN ('PARCEL', 'ADDRESS', 'BUILDING', 'BUILDING_UNIT')),
    CHECK (entity_status IN ('PROVISIONAL', 'ACTIVE', 'HISTORICAL', 'MERGED')),
    CHECK (id <> merged_into_id)
  )`,
  // NULL değerler SQLite tekil indeksinde çakışmaz: dış kimliği olmayan
  // geçici (PROVISIONAL) kayıtlar birbirini engellemez.
  "CREATE UNIQUE INDEX IF NOT EXISTS entities_authority_external_unique ON entities (authority_source, entity_type, external_id)",
  "CREATE INDEX IF NOT EXISTS entities_type_status_idx ON entities (entity_type, entity_status)",

  // VERI_SOZLUGU.md §9.1. Ada/parsel metindir; `12-A`, `3/1` ekleri korunur.
  // Bilinmeyen ilçe/kadastro mahallesi `UNKNOWN` sabitiyle tutulur; böylece
  // doğrulanmamış aynı ada/parsel anmaları tek geçici varlıkta toplanır.
  // ANA_SISTEM_TASARIM_BELGESI.md §7.5 gereği bu birleştirme hukuki parsel
  // kimliği sayılmaz; kesin kimlik CBS dış kimliğiyle verilir.
  `CREATE TABLE IF NOT EXISTS parcel_entities (
    entity_id TEXT PRIMARY KEY NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    parcel_external_id TEXT,
    district_code TEXT NOT NULL DEFAULT 'UNKNOWN',
    cadastral_neighborhood TEXT NOT NULL DEFAULT 'UNKNOWN',
    block_no TEXT NOT NULL,
    parcel_no TEXT NOT NULL,
    geometry_version TEXT,
    parcel_status TEXT NOT NULL DEFAULT 'UNKNOWN',
    CHECK (length(block_no) > 0),
    CHECK (length(parcel_no) > 0)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS parcel_entities_identity_unique ON parcel_entities (district_code, cadastral_neighborhood, block_no, parcel_no)",
  "CREATE INDEX IF NOT EXISTS parcel_entities_block_parcel_idx ON parcel_entities (block_no, parcel_no)",

  // VERI_SOZLUGU.md §9.2.
  `CREATE TABLE IF NOT EXISTS address_entities (
    entity_id TEXT PRIMARY KEY NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    address_external_id TEXT,
    national_address_id TEXT,
    neighborhood TEXT NOT NULL DEFAULT 'UNKNOWN',
    street TEXT NOT NULL DEFAULT 'UNKNOWN',
    door_no TEXT NOT NULL DEFAULT 'UNKNOWN',
    unit_no TEXT NOT NULL DEFAULT '',
    normalized_address TEXT NOT NULL,
    point_geometry TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS address_entities_identity_unique ON address_entities (neighborhood, street, door_no, unit_no)",
  "CREATE INDEX IF NOT EXISTS address_entities_normalized_idx ON address_entities (normalized_address)",

  // VERI_SOZLUGU.md §9.3.
  `CREATE TABLE IF NOT EXISTS building_entities (
    entity_id TEXT PRIMARY KEY NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    building_external_id TEXT,
    building_label TEXT NOT NULL,
    parcel_entity_id TEXT REFERENCES entities(id),
    building_geometry TEXT,
    unit_label TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS building_entities_parcel_idx ON building_entities (parcel_entity_id)",

  // VERI_SOZLUGU.md §10: belge-varlık ilişkisi. `TEXT_MENTION` ve
  // `SPATIAL_INTERSECTION` varsayılan olarak doğrulanmış ilişki sayılmaz.
  `CREATE TABLE IF NOT EXISTS document_entity_relations (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id),
    relation_type TEXT NOT NULL,
    relation_source TEXT NOT NULL,
    relation_confidence REAL,
    verification_status TEXT NOT NULL DEFAULT 'SUGGESTED',
    valid_from TEXT,
    valid_to TEXT,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    extracted_field_id TEXT REFERENCES extracted_fields(id) ON DELETE SET NULL,
    verified_by TEXT,
    verified_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (relation_type IN ('SUBJECT', 'AFFECTS', 'ATTACHMENT_REFERENCE', 'NEIGHBOR', 'PARTY', 'HISTORICAL_LINK', 'SPATIAL_INTERSECTION', 'TEXT_MENTION')),
    CHECK (relation_source IN ('GIS', 'HUMAN', 'OCR', 'INTEGRATION', 'SPATIAL')),
    CHECK (verification_status IN ('SUGGESTED', 'VERIFIED', 'REJECTED')),
    CHECK (verification_status <> 'VERIFIED' OR verified_by IS NOT NULL)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS document_entity_relations_unique ON document_entity_relations (document_id, entity_id, relation_type)",
  "CREATE INDEX IF NOT EXISTS document_entity_relations_document_idx ON document_entity_relations (document_id)",
  "CREATE INDEX IF NOT EXISTS document_entity_relations_entity_idx ON document_entity_relations (entity_id, verification_status)",

  // VERI_SOZLUGU.md §11: ifraz/tevhit eski kaydı ezmez, soy ilişkisi oluşturur.
  `CREATE TABLE IF NOT EXISTS parcel_lineage (
    id TEXT PRIMARY KEY NOT NULL,
    predecessor_parcel_id TEXT NOT NULL REFERENCES entities(id),
    successor_parcel_id TEXT NOT NULL REFERENCES entities(id),
    lineage_event_type TEXT NOT NULL,
    event_date TEXT,
    source_reference TEXT,
    verification_status TEXT NOT NULL DEFAULT 'SUGGESTED',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (lineage_event_type IN ('SUBDIVISION', 'MERGE', 'RENUMBER', 'BOUNDARY_CORRECTION', 'OTHER')),
    CHECK (verification_status IN ('SUGGESTED', 'VERIFIED', 'REJECTED')),
    CHECK (predecessor_parcel_id <> successor_parcel_id)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS parcel_lineage_unique ON parcel_lineage (predecessor_parcel_id, successor_parcel_id, lineage_event_type)",
  "CREATE INDEX IF NOT EXISTS parcel_lineage_predecessor_idx ON parcel_lineage (predecessor_parcel_id)",
  "CREATE INDEX IF NOT EXISTS parcel_lineage_successor_idx ON parcel_lineage (successor_parcel_id)",

  `CREATE TABLE IF NOT EXISTS archive_users (
    email TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    unit TEXT NOT NULL DEFAULT '*',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (role IN ('admin', 'archive_manager', 'reviewer', 'viewer')),
    CHECK (active IN (0, 1))
  )`,
  "CREATE INDEX IF NOT EXISTS archive_users_role_idx ON archive_users (role)",
  "CREATE INDEX IF NOT EXISTS archive_users_unit_idx ON archive_users (unit)",

  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    event_number INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    previous_hash TEXT,
    event_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS audit_events_document_number_unique ON audit_events (document_id, event_number)",
  "CREATE UNIQUE INDEX IF NOT EXISTS audit_events_hash_unique ON audit_events (event_hash)",
  "CREATE INDEX IF NOT EXISTS audit_events_document_created_idx ON audit_events (document_id, created_at)",
  `CREATE TRIGGER IF NOT EXISTS audit_events_no_update
    BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'Denetim kaydı değiştirilemez'); END`,
  `CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
    BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'Denetim kaydı silinemez'); END`,
];

async function tableExists(db: D1Database, table: string) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ name: string }>();
  return Boolean(row);
}

async function columnNames(db: D1Database, table: string) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(result.results.map((column) => column.name));
}

/**
 * `extracted_fields` tablosunu çoklu değer modeline taşır.
 *
 * Tek değer varsayımını uygulayan `UNIQUE(document_id, field_name)` indeksi ve
 * türetilebilir `needs_review` kolonu kaldırılır; `verification_status`,
 * `risk_level`, `value_index`, `origin` ve `vocabulary_version` eklenir. Tablo
 * yeniden kurulur, çünkü SQLite mevcut tabloya CHECK kısıtı eklemeye izin
 * vermez. D1 `batch()` tek işlem olduğu için adımlar ya tümüyle uygulanır ya
 * da geri alınır.
 */
async function migrateExtractedFieldsToMultiValue(db: D1Database) {
  if (!(await tableExists(db, "extracted_fields"))) return false;
  const columns = await columnNames(db, "extracted_fields");
  if (columns.has("verification_status")) return false;

  const hasNeedsReview = columns.has("needs_review");
  const statusExpression = hasNeedsReview
    ? `CASE WHEN needs_review = 1 THEN 'SUGGESTED' WHEN corrected_value IS NOT NULL THEN 'CORRECTED' ELSE 'CONFIRMED' END`
    : `CASE WHEN corrected_value IS NOT NULL THEN 'CORRECTED' ELSE 'SUGGESTED' END`;

  await db.batch([
    db.prepare(`CREATE TABLE extracted_fields_multivalue (
      id TEXT PRIMARY KEY NOT NULL,
      document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      value_index INTEGER NOT NULL DEFAULT 0,
      field_value TEXT NOT NULL,
      normalized_value TEXT,
      confidence REAL NOT NULL,
      risk_level TEXT NOT NULL DEFAULT 'MEDIUM',
      page_number INTEGER NOT NULL,
      bbox_json TEXT NOT NULL,
      evidence_text TEXT NOT NULL,
      model TEXT NOT NULL,
      vocabulary_version TEXT,
      verification_status TEXT NOT NULL DEFAULT 'SUGGESTED',
      origin TEXT NOT NULL DEFAULT 'OCR',
      verified_by TEXT,
      verified_at TEXT,
      corrected_value TEXT,
      corrected_by TEXT,
      corrected_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (verification_status IN ('SUGGESTED', 'CONFIRMED', 'CORRECTED', 'REJECTED')),
      CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
      CHECK (origin IN ('OCR', 'HUMAN')),
      CHECK (value_index >= 0)
    )`),
    db.prepare(`INSERT INTO extracted_fields_multivalue
      (id, document_id, field_name, value_index, field_value, normalized_value, confidence, risk_level,
       page_number, bbox_json, evidence_text, model, vocabulary_version, verification_status, origin,
       verified_by, verified_at, corrected_value, corrected_by, corrected_at, created_at, updated_at)
      SELECT id, document_id, field_name, 0, field_value, normalized_value, confidence,
        CASE
          WHEN field_value = 'Belirlenmedi' THEN 'CRITICAL'
          WHEN confidence >= 0.9 THEN 'LOW'
          WHEN confidence >= 0.75 THEN 'MEDIUM'
          ELSE 'HIGH'
        END,
        page_number, bbox_json, evidence_text, model, NULL, ${statusExpression}, 'OCR',
        corrected_by, corrected_at, corrected_value, corrected_by, corrected_at, created_at, updated_at
      FROM extracted_fields`),
    db.prepare("DROP TABLE extracted_fields"),
    db.prepare("ALTER TABLE extracted_fields_multivalue RENAME TO extracted_fields"),
  ]);
  return true;
}

/**
 * VERI_SOZLUGU.md §8 gereği doğrulayan ve doğrulama zamanı, düzelten ve düzeltme
 * zamanından ayrı tutulur: bir değeri değiştirmeden onaylamak da bir doğrulama
 * eylemidir ve aktörü kaydedilmelidir.
 */
async function migrateFieldVerifierColumns(db: D1Database) {
  if (!(await tableExists(db, "extracted_fields"))) return;
  const columns = await columnNames(db, "extracted_fields");
  if (!columns.has("verified_by")) await db.prepare("ALTER TABLE extracted_fields ADD COLUMN verified_by TEXT").run();
  if (!columns.has("verified_at")) await db.prepare("ALTER TABLE extracted_fields ADD COLUMN verified_at TEXT").run();
  // Geçmiş kayıtlarda doğrulayan yalnız düzeltme üzerinden bilinir.
  await db.prepare(`UPDATE extracted_fields
    SET verified_by = corrected_by, verified_at = corrected_at
    WHERE verified_by IS NULL AND corrected_by IS NOT NULL
      AND verification_status IN ('CONFIRMED', 'CORRECTED')`).run();
}

/** OCR sayfa tablosuna sonradan eklenen kolonların geriye dönük tamamlanması. */
async function migrateOcrPageColumns(db: D1Database) {
  if (!(await tableExists(db, "ocr_pages"))) return;
  const columns = await columnNames(db, "ocr_pages");
  const additions: Array<[string, string]> = [
    ["raw_text", "ALTER TABLE ocr_pages ADD COLUMN raw_text TEXT NOT NULL DEFAULT ''"],
    ["search_text", "ALTER TABLE ocr_pages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''"],
    ["confirmed_text", "ALTER TABLE ocr_pages ADD COLUMN confirmed_text TEXT"],
    ["confirmed_by", "ALTER TABLE ocr_pages ADD COLUMN confirmed_by TEXT"],
    ["confirmed_at", "ALTER TABLE ocr_pages ADD COLUMN confirmed_at TEXT"],
  ];
  for (const [column, statement] of additions) {
    if (!columns.has(column)) await db.prepare(statement).run();
  }
}

/**
 * Mevcut belgelerin asıl dosyaları için nesne kaydı üretir.
 * `archive_documents` kabul alındısını, `binary_objects` depolama kaydını tutar.
 */
async function backfillOriginalObjects(db: D1Database) {
  await db.prepare(`INSERT INTO binary_objects
    (id, document_id, object_class, object_key, storage_provider, bucket_or_namespace,
     media_type, byte_size, sha256, encryption_status, generator, created_at)
    SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
           substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' ||
           lower(hex(randomblob(6))),
      d.id, 'original', d.storage_key, 'r2', 'ARCHIVE_FILES',
      d.media_type, d.byte_size, d.sha256, 'provider-managed', 'ingest-backfill', d.created_at
    FROM archive_documents d
    WHERE NOT EXISTS (
      SELECT 1 FROM binary_objects o WHERE o.document_id = d.id AND o.object_class = 'original'
    )`).run();
}

/** Sürüm 4: belge türü profili ve alan tanımı bağları. */
async function migrateProfileColumns(db: D1Database) {
  if (await tableExists(db, "archive_documents")) {
    const columns = await columnNames(db, "archive_documents");
    if (!columns.has("document_type_id")) {
      await db.prepare("ALTER TABLE archive_documents ADD COLUMN document_type_id TEXT REFERENCES document_types(id)").run();
    }
    if (!columns.has("document_profile_version")) {
      await db.prepare("ALTER TABLE archive_documents ADD COLUMN document_profile_version TEXT").run();
    }
  }
  if (await tableExists(db, "extracted_fields")) {
    const columns = await columnNames(db, "extracted_fields");
    if (!columns.has("field_definition_id")) {
      await db.prepare("ALTER TABLE extracted_fields ADD COLUMN field_definition_id TEXT REFERENCES field_definitions(id)").run();
    }
  }
}

/**
 * Kontrollü sözlükleri ve belge türü profillerini yazar.
 *
 * Yalnız eksik kayıtlar eklenir; kurumun veritabanında yaptığı değişiklik geri
 * alınmaz. Kimlikler tohum verisi için okunabilir ve deterministiktir, böylece
 * yeniden çalıştırma yeni satır üretmez. (İleride profil yönetim arayüzü
 * eklendiğinde yeni kayıtlar UUID alır.)
 */
async function seedControlledVocabulariesAndProfiles(db: D1Database) {
  const statements: D1PreparedStatement[] = [];
  for (const vocabulary of seedVocabularies) {
    const vocabularyId = `vocab:${vocabulary.code}`;
    statements.push(db.prepare(`INSERT INTO vocabularies (id, code, name, owner, source, version, valid_from)
      VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(code) DO NOTHING`)
      .bind(vocabularyId, vocabulary.code, vocabulary.name, vocabulary.owner, vocabulary.source, SEED_PROFILE_VERSION));
    vocabulary.terms.forEach((term, index) => {
      statements.push(db.prepare(`INSERT INTO vocabulary_terms (id, vocabulary_id, code, label, sort_order)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(vocabulary_id, code) DO NOTHING`)
        .bind(`term:${vocabulary.code}:${term.code}`, vocabularyId, term.code, term.label, index));
    });
  }

  for (const documentType of seedDocumentTypes) {
    const typeId = `doctype:${documentType.code}@${SEED_PROFILE_VERSION}`;
    statements.push(db.prepare(`INSERT INTO document_types
      (id, code, name, owner_department, profile_version, profile_status, detection_markers_json)
      VALUES (?, ?, ?, ?, ?, 'HYPOTHESIS', ?) ON CONFLICT(code, profile_version) DO NOTHING`)
      .bind(typeId, documentType.code, documentType.name, documentType.ownerDepartment,
        SEED_PROFILE_VERSION, JSON.stringify(documentType.detectionMarkers)));
    seedFieldsFor(documentType.code).forEach((field, index) => {
      statements.push(db.prepare(`INSERT INTO field_definitions
        (id, document_type_id, field_code, label, data_type, cardinality, requirement, is_critical,
         extraction_policy, format_pattern, format_hint, vocabulary_code, enforce_vocabulary, entity_type, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_type_id, field_code) DO NOTHING`)
        .bind(`fielddef:${documentType.code}@${SEED_PROFILE_VERSION}:${field.fieldCode}`, typeId,
          field.fieldCode, field.label, field.dataType, field.cardinality, field.requirement,
          field.isCritical ? 1 : 0, extractionPolicyFor(field), field.formatPattern ?? null,
          field.formatHint ?? null, field.vocabularyCode ?? null, field.enforceVocabulary ? 1 : 0,
          field.entityType ?? null, index));
    });
  }
  await db.batch(statements);
}

/** Mevcut belgeleri ve alan değerlerini profil kayıtlarına bağlar. */
async function backfillProfileLinks(db: D1Database) {
  const activeProfile = `SELECT t.id, t.profile_version FROM document_types t
    WHERE t.name = archive_documents.document_type AND t.valid_to IS NULL
    ORDER BY t.profile_version DESC LIMIT 1`;
  await db.prepare(`UPDATE archive_documents SET
      document_type_id = (SELECT id FROM (${activeProfile})),
      document_profile_version = (SELECT profile_version FROM (${activeProfile}))
    WHERE document_type_id IS NULL`).run();
  await db.prepare(`UPDATE extracted_fields SET field_definition_id = (
      SELECT f.id FROM field_definitions f
      INNER JOIN archive_documents d ON d.id = extracted_fields.document_id
      WHERE f.document_type_id = d.document_type_id AND f.field_code = extracted_fields.field_name
      LIMIT 1)
    WHERE field_definition_id IS NULL`).run();
}

/**
 * Göç sonrası beklenen kolonların gerçekten var olduğunu doğrular.
 *
 * `CREATE TABLE IF NOT EXISTS` mevcut bir tabloya kolon eklemez; bir göç adımı
 * atlanır veya eksik kalırsa şema sessizce geride kalır ve hata çalışma
 * zamanında rastgele bir sorguda görünür. Sürüm damgası yalnız bu doğrulama
 * geçtikten sonra yazılır, böylece eksik şema açık bir hataya dönüşür.
 */
async function assertExpectedColumns(db: D1Database) {
  const expectations: Record<string, string[]> = {
    archive_documents: ["document_type_id", "document_profile_version"],
    extracted_fields: ["value_index", "verification_status", "risk_level", "origin", "verified_by", "verified_at", "vocabulary_version", "field_definition_id"],
    document_types: ["code", "profile_version", "profile_status", "detection_markers_json", "valid_to"],
    field_definitions: ["field_code", "cardinality", "requirement", "is_critical", "extraction_policy", "format_pattern", "vocabulary_code", "enforce_vocabulary"],
    vocabularies: ["code", "owner", "source", "version"],
    vocabulary_terms: ["vocabulary_id", "code", "label", "active"],
    binary_objects: ["object_class", "object_key", "derived_from_id", "retention_status", "legal_hold_status"],
    entities: ["entity_type", "authority_source", "external_id", "entity_status", "merged_into_id"],
    parcel_entities: ["district_code", "cadastral_neighborhood", "block_no", "parcel_no"],
    document_entity_relations: ["relation_type", "relation_source", "verification_status", "extracted_field_id"],
    parcel_lineage: ["lineage_event_type", "verification_status"],
  };
  for (const [table, expected] of Object.entries(expectations)) {
    const columns = await columnNames(db, table);
    const missing = expected.filter((column) => !columns.has(column));
    if (missing.length) {
      throw new Error(`Arşiv şeması eksik: ${table} tablosunda ${missing.join(", ")} kolonu bulunmuyor. `
        + `Göç adımı çalışmamış olabilir; schema_state sürümünü düşürüp yeniden çalıştırın.`);
    }
  }
}

/**
 * Sürüme bağlı göç adımları. Her adım, hedef sürümünün altındaki her
 * veritabanında bir kez çalışır ve kendi içinde yeniden çalıştırılabilir olmalıdır.
 * Yeni bir alan/tablo eklerken burada yeni bir adım açılır ve
 * `ARCHIVE_SCHEMA_VERSION` artırılır.
 */
const migrations: Array<{ version: number; run: (db: D1Database) => Promise<unknown> }> = [
  // 1 → 2: `extracted_fields` çoklu değer modeline geçer.
  { version: 2, run: migrateExtractedFieldsToMultiValue },
  { version: 2, run: migrateOcrPageColumns },
  // 2 → 3: doğrulayan/doğrulama zamanı düzeltme alanlarından ayrılır.
  { version: 3, run: migrateFieldVerifierColumns },
  // 3 → 4: belge türü profili ve alan tanımı bağları.
  { version: 4, run: migrateProfileColumns },
];

export async function ensureArchiveSchema(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_state (
    id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  const state = await db.prepare("SELECT version FROM schema_state WHERE id = 'archive'").first<{ version: number }>();
  const current = state?.version ?? 0;
  if (current === ARCHIVE_SCHEMA_VERSION) return;

  // Sıra önemlidir: `extracted_fields` yeniden kurulmadan ona yabancı anahtarla
  // bağlanan `document_entity_relations` oluşturulmamalıdır.
  for (const migration of migrations) {
    if (current < migration.version) await migration.run(db);
  }

  await db.batch(tableStatements.map((statement) => db.prepare(statement)));
  await backfillOriginalObjects(db);
  await seedControlledVocabulariesAndProfiles(db);
  await backfillProfileLinks(db);
  await assertExpectedColumns(db);

  await db.prepare(`INSERT INTO schema_state (id, version, updated_at) VALUES ('archive', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = CURRENT_TIMESTAMP`)
    .bind(ARCHIVE_SCHEMA_VERSION).run();
}
