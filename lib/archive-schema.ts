/**
 * Arşiv veritabanı şeması — **yetkili kaynak**.
 *
 * Tablolar, indeksler, kısıtlar, tetikleyiciler, sürümlü göçler ve tohum verisi
 * burada tanımlanır. `db/schema.ts` yalnız Drizzle tip aynasıdır ve sorgu
 * üretiminde kullanılmaz; iki tanımın kolon düzeyinde ayrışması
 * `tests/schema-contract.test.ts` ile engellenir. Beklenen kolon listesi elle
 * tutulmaz, `SCHEMA_MANIFEST` ile DDL'den türetilir.
 *
 * **Yürütme sınırı:** `applyArchiveMigrations` değiştirici işlemdir ve istek
 * yolunda çağrılmaz. Rotalar `requireArchiveSchema` ile yalnız sürümü doğrular;
 * DDL yetkili göç uç noktasından (`POST /api/admin/migrate`) veya yerel
 * geliştirmede çalışır. Sıradan bir okuma isteğinin şema değiştirebilmesi hem
 * yetki modelini hem eşzamanlı dağıtım güvenliğini zedeler.
 *
 * **PostgreSQL taşınabilirliği (yol haritası, kurumsal karara bağlı):** DDL
 * bilinçli olarak SQLite lehçesindedir. Taşımada gözden geçirilecek noktalar:
 * `TEXT` zaman damgaları yerine `timestamptz`, `INTEGER` boolean yerine
 * `boolean`, kısmi tekil indeks sözdizimi (PostgreSQL destekler), `PRAGMA
 * table_info` yerine `information_schema`, tetikleyici dili, ve
 * `db.batch()`in yerini alacak gerçek işlem yönetimi. Üretim yerleşimi
 * (kurum içi/bulut) kararı verilmeden taşıma başlatılmamalıdır
 * (ANA_SISTEM_TASARIM_BELGESI.md §16).
 */

import {
  FIELD_REJECTION_VOCABULARY_CODE, RELATION_REJECTION_VOCABULARY_CODE,
} from "./rejection-reasons.ts";
import { FILE_PLAN_VOCABULARY_CODE, RETENTION_RULE_VOCABULARY_CODE } from "./file-plan.ts";
import {
  DEFAULT_DOCUMENT_TYPE_CODE, SEED_PROFILE_VERSION, extractionPolicyFor,
  seedDocumentTypes, seedFieldsFor, seedVocabularies,
} from "./archive-seed.ts";
import { jsonError } from "./http.ts";
import { ingestTableStatements } from "./ingest-schema.ts";
import { normalizeSearch } from "./text-search.ts";

export { DEFAULT_DOCUMENT_TYPE_CODE };

/**
 * Şema sürümü. Tablo, indeks veya kolon eklendiğinde **her zaman** artırılır ve
 * `migrations` listesine karşılık gelen adım eklenir.
 *
 * Göç adımları sürüme göre planlanır, kolon yokluğuna göre değil: bir adım
 * çalıştıktan sonra aynı tabloya yeni kolon eklenirse, kolon sniffing yapan bir
 * kapı adımı bir daha çalıştırmaz ve şema sessizce eksik kalır.
 */
export const ARCHIVE_SCHEMA_VERSION = 28;

/**
 * Bağımlılık sırasına göre tablo ve indeks tanımları.
 *
 * `archive_documents` üzerindeki `storage_key`/`sha256`/`byte_size`/`media_type`
 * kolonları kabul alındısıdır (VERI_SOZLUGU.md §5) ve tekrar kontrolünü besler;
 * nesne kayıtlarının yetkili listesi `binary_objects` tablosudur.
 */
const tableStatements: string[] = [
  // Sürüm kapısı tablosu; `applyArchiveMigrations` bunu sürümü okuyabilmek için
  // ayrıca oluşturur, burada da bildirilir ki şema manifestine dâhil olsun.
  `CREATE TABLE IF NOT EXISTS schema_state (
    id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  /**
   * Uzun süren bakım işleri.
   *
   * Bütün arşivi dolaşan bir işi göç adımının içinde çalıştırmak, büyük arşivde
   * istek zaman aşımına ve her denemede baştan başlamaya yol açar. Bu tablo işi
   * kilitli, ilerleme işaretli ve kaldığı yerden devam edebilir hâle getirir;
   * göç yalnız işi kuyruğa alır.
   */
  `CREATE TABLE IF NOT EXISTS maintenance_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    cursor TEXT,
    processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER,
    locked_until TEXT,
    lease_token TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
    CHECK (processed >= 0)
  )`,
  "CREATE INDEX IF NOT EXISTS maintenance_tasks_status_idx ON maintenance_tasks (status)",
  ...ingestTableStatements,
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
    -- design.md §9.5: arşivleme tasnifi. Kod + etiket karar anının anlık
    -- görüntüsüdür (ret gerekçesi deseni); sözlük sonradan değişse bile
    -- arşivdeki tasnif okunur kalır. Arşivlenmemiş belgede boştur.
    file_plan_code TEXT,
    file_plan_label TEXT,
    retention_rule_code TEXT,
    retention_rule_label TEXT,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS archive_documents_profile_idx ON archive_documents (document_type_id)",
  "CREATE INDEX IF NOT EXISTS archive_documents_status_idx ON archive_documents (status)",
  "CREATE INDEX IF NOT EXISTS archive_documents_created_at_idx ON archive_documents (created_at)",
  // Anahtar kümesi (keyset) sayfalama: sıralama `created_at, id` ikilisiyle
  // kararlıdır; süzülmüş listeler için durum önde gelir.
  "CREATE INDEX IF NOT EXISTS archive_documents_created_id_idx ON archive_documents (created_at, id)",
  "CREATE INDEX IF NOT EXISTS archive_documents_status_created_id_idx ON archive_documents (status, created_at, id)",

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
    page_start INTEGER,
    page_end INTEGER,
    derivative_generation_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (object_class IN ('original', 'access', 'ocr', 'preservation', 'thumbnail', 'quarantine', 'temporary')),
    CHECK (retention_status IN ('ACTIVE', 'RETENTION_REVIEW', 'DISPOSED')),
    CHECK (legal_hold_status IN ('NONE', 'HELD')),
    CHECK (byte_size >= 0),
    CHECK (id <> derived_from_id),
    CHECK (page_start IS NULL OR page_start >= 1),
    CHECK (page_end IS NULL OR (page_start IS NOT NULL AND page_end >= page_start))
  )`,
  "CREATE INDEX IF NOT EXISTS binary_objects_document_class_idx ON binary_objects (document_id, object_class)",
  "CREATE INDEX IF NOT EXISTS binary_objects_sha256_idx ON binary_objects (sha256)",

  // Bir belgenin yalnız bir asıl nesnesi olabilir; türevler serbesttir.
  "CREATE UNIQUE INDEX IF NOT EXISTS binary_objects_single_original_unique ON binary_objects (document_id) WHERE object_class = 'original'",
  "CREATE UNIQUE INDEX IF NOT EXISTS binary_objects_original_sha256_unique ON binary_objects (sha256) WHERE object_class = 'original'",

  `CREATE TABLE IF NOT EXISTS processing_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'ocr',
    status TEXT NOT NULL DEFAULT 'queued',
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    model TEXT NOT NULL DEFAULT 'paddleocr-local',
    error_message TEXT,
    next_attempt_at TEXT,
    last_attempt_at TEXT,
    dead_lettered_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS processing_jobs_status_created_idx ON processing_jobs (status, created_at)",
  "CREATE INDEX IF NOT EXISTS processing_jobs_schedule_idx ON processing_jobs (status, next_attempt_at, created_at)",
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
    rejection_reason_code TEXT,
    rejection_reason_label TEXT,
    rejection_reason_note TEXT,
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

  /*
   * Kullanıcı ve rol yönetimi denetim kaydı.
   *
   * `audit_events` belgeye bağlıdır (document_id NOT NULL + FK), bu yüzden
   * yetki değişiklikleri oraya yazılamaz. Yetkilendirme kararları kurumsal
   * denetimin konusudur: kim, kimin rolünü/birimini/erişimini, ne zaman
   * değiştirdi. Kayıt yalnız eklenebilir; güncelleme ve silme tetikleyiciyle
   * reddedilir.
   */
  /*
   * `action` ve `target_kind` kısıtları sayım değil ŞEKİL denetler.
   * Yönetilebilir sözlükler koddaki bir kayıt defterinden gelir ve her yeni
   * liste için şema göçü gerektirmemelidir; enumerasyonu SQL'de tekrarlamak,
   * kodla şemanın zamanla ayrışacağı ikinci bir yer açardı. Şekil denetimi
   * yazım hatasını ve anlamsız eylemi yine de durdurur.
   */
  `CREATE TABLE IF NOT EXISTS user_admin_events (
    id TEXT PRIMARY KEY NOT NULL,
    actor TEXT NOT NULL,
    target_email TEXT NOT NULL,
    action TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    target_kind TEXT NOT NULL DEFAULT 'user',
    CHECK (action LIKE '%.created' OR action LIKE '%.updated'),
    CHECK (length(target_kind) BETWEEN 1 AND 64 AND target_kind NOT LIKE '% %')
  )`,
  "CREATE INDEX IF NOT EXISTS user_admin_events_target_idx ON user_admin_events (target_email, created_at)",
  "CREATE INDEX IF NOT EXISTS user_admin_events_created_idx ON user_admin_events (created_at)",
  `CREATE TRIGGER IF NOT EXISTS user_admin_events_no_update
    BEFORE UPDATE ON user_admin_events BEGIN SELECT RAISE(ABORT, 'Kullanıcı denetim kaydı değiştirilemez'); END`,
  `CREATE TRIGGER IF NOT EXISTS user_admin_events_no_delete
    BEFORE DELETE ON user_admin_events BEGIN SELECT RAISE(ABORT, 'Kullanıcı denetim kaydı silinemez'); END`,

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

const MIGRATE_HINT = "göçü `POST /api/admin/migrate` ile çalıştırın.";

/**
 * `CREATE TABLE` ifadesinden kolon adlarını çıkarır.
 *
 * Beklenen kolon listesi elle tutulmaz: doğrulama, DDL'in kendi bildirimiyle
 * karşılaştırılır. Elle tutulan bir liste, `CREATE TABLE`'a kolon eklenip göç
 * adımı yazılmadığında sessiz kalır — bu tam olarak sürüm 3'te yaşanan hataydı.
 */
export function declaredColumns(createStatement: string): string[] {
  const open = createStatement.indexOf("(");
  const close = createStatement.lastIndexOf(")");
  if (open < 0 || close <= open) return [];
  const body = createStatement.slice(open + 1, close);

  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);

  const constraintKeywords = /^(check|primary|foreign|unique|constraint)\b/i;
  return parts
    // Satır içi açıklamalar kolon bildirimi değildir.
    .map((part) => part.split("\n").filter((line) => !line.trim().startsWith("--")).join(" ").trim())
    .filter((part) => part.length > 0 && !constraintKeywords.test(part))
    .map((part) => part.split(/\s+/)[0].replace(/[`"[\]]/g, ""))
    .filter((name) => /^[a-z_][a-z0-9_]*$/i.test(name));
}

/** Tablo → DDL'de bildirilen kolonlar. Doğrulamanın ve sapma testinin kaynağı. */
export const SCHEMA_MANIFEST: Record<string, string[]> = Object.fromEntries(
  tableStatements
    .map((statement) => ({ statement, match: /CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/i.exec(statement) }))
    .filter((entry): entry is { statement: string; match: RegExpExecArray } => Boolean(entry.match))
    .map(({ statement, match }) => [match[1], declaredColumns(statement)]),
);

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
 * Ret gerekçesi alan kaydının kendisine de yazılır.
 *
 * Gerekçe yalnız denetim zincirindeyken belgeye bakan personel onu göremiyor,
 * "Reddedildi" ibaresini sebepsiz okuyordu. Etiket de saklanır: gerekçe
 * sözlüğü kurumca düzenlenebilir olduğundan, bir kodun bugünkü karşılığı
 * kararın verildiği andaki karşılığı olmayabilir.
 */
async function migrateFieldRejectionReasonColumns(db: D1Database) {
  if (!(await tableExists(db, "extracted_fields"))) return;
  const columns = await columnNames(db, "extracted_fields");
  const additions: Array<[string, string]> = [
    ["rejection_reason_code", "ALTER TABLE extracted_fields ADD COLUMN rejection_reason_code TEXT"],
    ["rejection_reason_label", "ALTER TABLE extracted_fields ADD COLUMN rejection_reason_label TEXT"],
    ["rejection_reason_note", "ALTER TABLE extracted_fields ADD COLUMN rejection_reason_note TEXT"],
  ];
  for (const [column, statement] of additions) {
    if (!columns.has(column)) await db.prepare(statement).run();
  }
}

/**
 * design.md §9.5: arşivleme tasnifi (dosya planı + saklama kuralı) belge
 * kaydında kod ve etiket anlık görüntüsüyle saklanır.
 */
async function migrateArchiveClassificationColumns(db: D1Database) {
  if (!(await tableExists(db, "archive_documents"))) return;
  const columns = await columnNames(db, "archive_documents");
  const additions: Array<[string, string]> = [
    ["file_plan_code", "ALTER TABLE archive_documents ADD COLUMN file_plan_code TEXT"],
    ["file_plan_label", "ALTER TABLE archive_documents ADD COLUMN file_plan_label TEXT"],
    ["retention_rule_code", "ALTER TABLE archive_documents ADD COLUMN retention_rule_code TEXT"],
    ["retention_rule_label", "ALTER TABLE archive_documents ADD COLUMN retention_rule_label TEXT"],
  ];
  for (const [column, statement] of additions) {
    if (!columns.has(column)) await db.prepare(statement).run();
  }
}

/** Faz 0: OCR yeniden deneme, zamanlama ve dead-letter görünürlüğü. */
async function migrateProcessingJobOperationsColumns(db: D1Database) {
  if (!(await tableExists(db, "processing_jobs"))) return;
  const columns = await columnNames(db, "processing_jobs");
  const additions: Array<[string, string]> = [
    ["next_attempt_at", "ALTER TABLE processing_jobs ADD COLUMN next_attempt_at TEXT"],
    ["last_attempt_at", "ALTER TABLE processing_jobs ADD COLUMN last_attempt_at TEXT"],
    ["dead_lettered_at", "ALTER TABLE processing_jobs ADD COLUMN dead_lettered_at TEXT"],
  ];
  for (const [column, statement] of additions) {
    if (!columns.has(column)) await db.prepare(statement).run();
  }
}

/** F1.3: dağıtık parça yüklemelerinde oturum başına en çok dört aktif istek. */
async function migrateIngestSessionConcurrencyColumn(db: D1Database) {
  if (!(await tableExists(db, "upload_sessions"))) return;
  const columns = await columnNames(db, "upload_sessions");
  if (!columns.has("in_flight_parts")) {
    await db.prepare("ALTER TABLE upload_sessions ADD COLUMN in_flight_parts INTEGER NOT NULL DEFAULT 0 CHECK (in_flight_parts BETWEEN 0 AND 4)").run();
  }
}

/** F1.3: sonraki kabul aşamalarının belge üst verisini oturumda korur. */
async function migrateIngestSessionDocumentMetadata(db: D1Database) {
  if (!(await tableExists(db, "upload_sessions"))) return;
  const columns = await columnNames(db, "upload_sessions");
  if (!columns.has("original_name")) {
    await db.prepare("ALTER TABLE upload_sessions ADD COLUMN original_name TEXT NOT NULL DEFAULT 'belge'").run();
  }
  if (!columns.has("requested_document_type")) {
    await db.prepare("ALTER TABLE upload_sessions ADD COLUMN requested_document_type TEXT NOT NULL DEFAULT 'Tasnif bekliyor'").run();
  }
}

/**
 * F1.3 düzeltmesi: parça slotları süresiz sayaç yerine kiraya bağlanır.
 *
 * Worker isolate'i parça yüklemesi ortasında düşerse `finally` çalışmaz ve
 * `in_flight_parts` sızar; oturum süre dolumuna kadar 429'a kilitlenirdi. Kira
 * damgası, ADR-014'teki 15 dakikalık parça yazma yetkisi dolduğunda sayacın
 * güvenle sıfırlanmasına izin verir.
 */
async function migrateIngestSessionPartLease(db: D1Database) {
  if (!(await tableExists(db, "upload_sessions"))) return;
  const columns = await columnNames(db, "upload_sessions");
  if (!columns.has("parts_lease_expires_at")) {
    await db.prepare("ALTER TABLE upload_sessions ADD COLUMN parts_lease_expires_at TEXT").run();
  }
}
/** F1.3 düzeltmesi: her aktif parça isteği kendi kira/fencing kimliğini taşır. */
async function createUploadPartLeases(db: D1Database) {
  for (const statement of ingestTableStatements.filter((sql) => sql.includes("upload_part_leases"))) {
    await db.prepare(statement).run();
  }
}
/** F1.4: ayrıştırıcı kanıtı ve kiralı/dead-letter görünür tarama işi. */
async function migrateContentScanEvidence(db: D1Database) {
  if (await tableExists(db, "ingest_receipts")) {
    const columns = await columnNames(db, "ingest_receipts");
    const additions: Array<[string, string]> = [
      ["parser_name", "ALTER TABLE ingest_receipts ADD COLUMN parser_name TEXT NOT NULL DEFAULT 'unknown'"],
      ["parser_version", "ALTER TABLE ingest_receipts ADD COLUMN parser_version TEXT NOT NULL DEFAULT 'unknown'"],
      ["parser_result", "ALTER TABLE ingest_receipts ADD COLUMN parser_result TEXT NOT NULL DEFAULT 'ERROR' CHECK (parser_result IN ('VALID', 'INVALID', 'ERROR'))"],
    ];
    for (const [column, sql] of additions) if (!columns.has(column)) await db.prepare(sql).run();
  }
  for (const statement of ingestTableStatements.filter((sql) => sql.includes("content_scan_jobs"))) {
    await db.prepare(statement).run();
  }
}
/** F1.5: kiralı terfi kuyruğu ve değiştirilemez kasa doğrulama kanıtı. */
async function createPromotionEvidenceTables(db: D1Database) {
  for (const statement of ingestTableStatements.filter((sql) =>
    sql.includes("promotion_jobs") || sql.includes("promotion_receipts"))) {
    await db.prepare(statement).run();
  }
  if (!(await tableExists(db, "upload_sessions"))) return;
  // CREATE TRIGGER IF NOT EXISTS, v13 geçiş kümesini kendiliğinden yükseltmez.
  await db.prepare("DROP TRIGGER IF EXISTS upload_sessions_transition_guard").run();
  const transitionGuard = ingestTableStatements.find((sql) =>
    sql.includes("CREATE TRIGGER IF NOT EXISTS upload_sessions_transition_guard"));
  if (!transitionGuard) throw new Error("Upload session transition guard DDL is missing.");
  await db.prepare(transitionGuard).run();
}

/** F1.2 düzeltmesi: deneme geçmişi korunur, yalnız VERIFIED sonuç tekildir. */
async function migrateIngestReceiptHistory(db: D1Database) {
  await db.prepare("DROP INDEX IF EXISTS ingest_receipts_session_unique").run();
}
/** Sürüm 8: içerik tekilliğinin yetkisini `binary_objects` tablosuna taşır. */
async function migrateOriginalShaUniqueness(db: D1Database) {
  await db.prepare("DROP INDEX IF EXISTS archive_documents_sha256_unique").run();
}

/** F1.8: eski anahtar envanter/taşıma tablosu mevcut kurulumlara eklenir. */
async function createLegacyKeyMigrationTable(db: D1Database) {
  for (const statement of ingestTableStatements.filter((sql) => sql.includes("legacy_key_migrations"))) {
    await db.prepare(statement).run();
  }
}

/** F1.9: görüntüleme oturumu tablosu mevcut kurulumlara eklenir. */
async function createAccessSessionTable(db: D1Database) {
  for (const statement of ingestTableStatements.filter((sql) => sql.includes("access_sessions"))) {
    await db.prepare(statement).run();
  }
}

/** Kullanıcı/rol yönetimi denetim kaydı mevcut kurulumlara eklenir. */
async function createUserAdminEventTable(db: D1Database) {
  for (const statement of tableStatements.filter((sql) => sql.includes("user_admin_events"))) {
    await db.prepare(statement).run();
  }
}

/**
 * Yönetim denetim kaydı müdürlük (sözlük) olaylarını da taşır.
 *
 * `target_email` kolonu adı geriye dönük uyumluluk için korunur; artık genel
 * hedef kimliğidir: kullanıcı olaylarında e-posta, müdürlük olaylarında
 * müdürlük kodudur (`target_kind` hangisi olduğunu söyler). CHECK kısıtı
 * SQLite'ta ALTER ile değiştirilemediğinden yeni kurulumlar genişletilmiş
 * kısıtı alır; mevcut kurulumlarda kolon eklenir ve eski kısıt yalnız
 * kullanıcı olaylarını sınırlar — bu yüzden müdürlük olayları için tablo
 * yeniden oluşturulur.
 */
async function widenAdminEventTargets(db: D1Database) {
  if (!(await tableExists(db, "user_admin_events"))) {
    await createUserAdminEventTable(db);
    return;
  }
  const columns = await columnNames(db, "user_admin_events");
  if (columns.has("target_kind")) return;
  // Denetim kaydı silinemez/değiştirilemez; taşıma için tetikleyiciler
  // geçici olarak kaldırılır, veri kopyalanır ve yeniden kurulur.
  await db.prepare("DROP TRIGGER IF EXISTS user_admin_events_no_update").run();
  await db.prepare("DROP TRIGGER IF EXISTS user_admin_events_no_delete").run();
  await db.prepare("ALTER TABLE user_admin_events RENAME TO user_admin_events_v23").run();
  for (const statement of tableStatements.filter((sql) => sql.includes("user_admin_events"))) {
    await db.prepare(statement).run();
  }
  await db.prepare(`INSERT INTO user_admin_events
      (id, actor, target_email, action, previous_state, new_state, created_at, target_kind)
    SELECT id, actor, target_email, action, previous_state, new_state, created_at, 'user'
    FROM user_admin_events_v23`).run();
  await db.prepare("DROP TABLE user_admin_events_v23").run();
}

/**
 * Yönetim denetim kaydındaki sabit eylem/hedef listesi şekil denetimine
 * çevrilir; ret gerekçesi gibi yeni yönetilebilir sözlükler kendi adlarını
 * yazabilsin diye. Kayıt silinemez/değiştirilemez olduğundan taşıma için
 * tetikleyiciler geçici kaldırılır ve yeniden kurulur.
 */
async function relaxAdminEventConstraints(db: D1Database) {
  if (!(await tableExists(db, "user_admin_events"))) {
    await createUserAdminEventTable(db);
    return;
  }
  const definition = await db.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'user_admin_events'`).first<{ sql: string }>();
  if (definition?.sql && !definition.sql.includes("action IN (")) return;
  await db.prepare("DROP TRIGGER IF EXISTS user_admin_events_no_update").run();
  await db.prepare("DROP TRIGGER IF EXISTS user_admin_events_no_delete").run();
  await db.prepare("ALTER TABLE user_admin_events RENAME TO user_admin_events_v25").run();
  for (const statement of tableStatements.filter((sql) => sql.includes("user_admin_events"))) {
    await db.prepare(statement).run();
  }
  await db.prepare(`INSERT INTO user_admin_events
      (id, actor, target_email, action, previous_state, new_state, created_at, target_kind)
    SELECT id, actor, target_email, action, previous_state, new_state, created_at, target_kind
    FROM user_admin_events_v25`).run();
  await db.prepare("DROP TABLE user_admin_events_v25").run();
}

/** F1.9 sertleştirmesi: bilet belge+sınıf bağını ve kapalı amaç kodunu taşır. */
async function hardenAccessTicketBindings(db: D1Database) {
  if (!(await tableExists(db, "access_tickets"))) return;
  const columns = await columnNames(db, "access_tickets");
  if (!columns.has("document_id")) {
    await db.prepare("ALTER TABLE access_tickets ADD COLUMN document_id TEXT REFERENCES archive_documents(id)").run();
  }
  if (!columns.has("object_class")) {
    await db.prepare("ALTER TABLE access_tickets ADD COLUMN object_class TEXT").run();
  }
  await db.prepare(`UPDATE access_tickets SET
      document_id = (SELECT document_id FROM binary_objects WHERE id = access_tickets.binary_object_id),
      object_class = (SELECT object_class FROM binary_objects WHERE id = access_tickets.binary_object_id),
      purpose = CASE scope WHEN 'VIEW' THEN 'DOCUMENT_REVIEW' ELSE 'ORIGINAL_DOWNLOAD' END
    WHERE document_id IS NULL OR object_class IS NULL
      OR purpose NOT IN ('DOCUMENT_REVIEW', 'ORIGINAL_DOWNLOAD')`).run();
  if (await tableExists(db, "access_sessions")) {
    await db.prepare(`UPDATE access_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
      WHERE object_class <> 'access'`).run();
    await db.prepare(`UPDATE access_sessions SET purpose = 'DOCUMENT_REVIEW'
      WHERE object_class = 'access' AND purpose <> 'DOCUMENT_REVIEW'`).run();
  }
  for (const statement of ingestTableStatements.filter((sql) =>
    sql.includes("CREATE TRIGGER IF NOT EXISTS access_"))) {
    await db.prepare(statement).run();
  }
}

/** F1.8 sertleştirmesi: kaynak kopyanın bekleme ve ayrı tasfiye kanıtı. */
async function migrateLegacyKeyRetentionEvidence(db: D1Database) {
  if (!(await tableExists(db, "legacy_key_migrations"))) return;
  const columns = await columnNames(db, "legacy_key_migrations");
  if (!columns.has("source_retire_after")) {
    await db.prepare("ALTER TABLE legacy_key_migrations ADD COLUMN source_retire_after TEXT").run();
  }
  if (!columns.has("source_disposed_at")) {
    await db.prepare("ALTER TABLE legacy_key_migrations ADD COLUMN source_disposed_at TEXT").run();
  }
}

/** F1.7 / ADR-015: bölümlü erişim türevleri sayfa aralığıyla kaydedilir. */
async function migrateBinaryObjectPageRange(db: D1Database) {
  if (!(await tableExists(db, "binary_objects"))) return;
  const columns = await columnNames(db, "binary_objects");
  if (!columns.has("page_start")) {
    await db.prepare("ALTER TABLE binary_objects ADD COLUMN page_start INTEGER CHECK (page_start IS NULL OR page_start >= 1)").run();
  }
  if (!columns.has("page_end")) {
    await db.prepare("ALTER TABLE binary_objects ADD COLUMN page_end INTEGER CHECK (page_end IS NULL OR page_end >= 1)").run();
  }
}

/** F1.7 sertleştirmesi: segmentleri tek, kanıtlanmış üretim kuşağına bağlar. */
async function migrateDerivativeGenerationEvidence(db: D1Database) {
  if (await tableExists(db, "binary_objects")) {
    const columns = await columnNames(db, "binary_objects");
    if (!columns.has("derivative_generation_id")) {
      await db.prepare("ALTER TABLE binary_objects ADD COLUMN derivative_generation_id TEXT").run();
    }
    await db.prepare(
      "CREATE INDEX IF NOT EXISTS binary_objects_generation_idx ON binary_objects (derivative_generation_id, page_start)",
    ).run();
  }
  if (!(await tableExists(db, "derivative_jobs"))) return;

  // v17 `document_id UNIQUE` ile profil yükseltmesini engelliyordu. SQLite
  // tablo-kısıtı düşüremediği için işi kanıt alanlarıyla birlikte yeniden kurarız.
  await db.prepare("DROP TABLE IF EXISTS derivative_jobs_v18").run();
  await db.prepare(`CREATE TABLE derivative_jobs_v18 (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES archive_documents(id) ON DELETE CASCADE,
    source_binary_object_id TEXT NOT NULL REFERENCES binary_objects(id),
    profile_version TEXT NOT NULL DEFAULT 'access-pdf-v1',
    status TEXT NOT NULL DEFAULT 'QUEUED',
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    failure_code TEXT,
    last_error TEXT,
    renderer TEXT,
    renderer_version TEXT,
    renderer_image_digest TEXT,
    page_count INTEGER,
    segment_count INTEGER,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status IN ('QUEUED', 'RENDERING', 'RETRY', 'COMPLETED', 'REVIEW_REQUIRED', 'FAILED')),
    CHECK (attempt >= 0 AND max_attempts BETWEEN 1 AND 20),
    CHECK (page_count IS NULL OR page_count >= 1),
    CHECK (segment_count IS NULL OR segment_count >= 1)
  )`).run();
  const columns = await columnNames(db, "derivative_jobs");
  const profile = columns.has("profile_version") ? "profile_version" : "'access-pdf-v1'";
  const renderer = columns.has("renderer") ? "renderer" : "NULL";
  const rendererVersion = columns.has("renderer_version") ? "renderer_version" : "NULL";
  const imageDigest = columns.has("renderer_image_digest") ? "renderer_image_digest" : "NULL";
  const pageCount = columns.has("page_count") ? "page_count" : "NULL";
  const segmentCount = columns.has("segment_count") ? "segment_count" : "NULL";
  const completedAt = columns.has("completed_at") ? "completed_at" : "NULL";
  await db.prepare(`INSERT INTO derivative_jobs_v18
      (id, document_id, source_binary_object_id, profile_version, status, attempt, max_attempts,
       next_attempt_at, lease_token, lease_expires_at, failure_code, last_error,
       renderer, renderer_version, renderer_image_digest, page_count, segment_count,
       completed_at, created_at, updated_at)
    SELECT id, document_id, source_binary_object_id, ${profile}, status, attempt, max_attempts,
       next_attempt_at, lease_token, lease_expires_at, failure_code, last_error,
       ${renderer}, ${rendererVersion}, ${imageDigest}, ${pageCount}, ${segmentCount},
       ${completedAt}, created_at, updated_at
    FROM derivative_jobs`).run();
  await db.prepare("DROP TABLE derivative_jobs").run();
  await db.prepare("ALTER TABLE derivative_jobs_v18 RENAME TO derivative_jobs").run();
  await db.prepare(
    "CREATE INDEX derivative_jobs_claim_idx ON derivative_jobs (status, next_attempt_at, lease_expires_at, created_at)",
  ).run();
  await db.prepare(
    "CREATE UNIQUE INDEX derivative_jobs_document_profile_unique ON derivative_jobs (document_id, profile_version)",
  ).run();
}

/** F1.6: hızlı (metadata) ve tam (akışlı SHA) tarama koşuları ayrışır. */
async function migrateIntegrityRunProfile(db: D1Database) {
  if (!(await tableExists(db, "integrity_runs"))) return;
  const columns = await columnNames(db, "integrity_runs");
  if (!columns.has("profile")) {
    await db.prepare(
      "ALTER TABLE integrity_runs ADD COLUMN profile TEXT NOT NULL DEFAULT 'quick' CHECK (profile IN ('quick', 'full'))",
    ).run();
  }
}

/** F1.6 güvenlik sertleştirmesi: kiralı iş ve sabit tarama anlık görüntüleri. */
async function hardenIntegrityAndReconciliationRuns(db: D1Database) {
  if (await tableExists(db, "maintenance_tasks")) {
    const columns = await columnNames(db, "maintenance_tasks");
    if (!columns.has("lease_token")) {
      await db.prepare("ALTER TABLE maintenance_tasks ADD COLUMN lease_token TEXT").run();
    }
  }
  if (await tableExists(db, "integrity_runs")) {
    const columns = await columnNames(db, "integrity_runs");
    if (!columns.has("snapshot_max_rowid")) {
      await db.prepare("ALTER TABLE integrity_runs ADD COLUMN snapshot_max_rowid INTEGER").run();
    }
  }
  if (await tableExists(db, "reconciliation_runs")) {
    const columns = await columnNames(db, "reconciliation_runs");
    if (!columns.has("binary_snapshot_max_rowid")) {
      await db.prepare("ALTER TABLE reconciliation_runs ADD COLUMN binary_snapshot_max_rowid INTEGER").run();
    }
    if (!columns.has("document_snapshot_max_rowid")) {
      await db.prepare("ALTER TABLE reconciliation_runs ADD COLUMN document_snapshot_max_rowid INTEGER").run();
    }
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

/**
 * Sürüm 5: Türkçe locale küçültmesiyle bozulmuş e-posta kayıtlarını onarır.
 *
 * `"IBRAHIM@..."` değeri `tr` kuralıyla `"ıbrahim@..."` olarak yazılmış olabilir.
 * `ı` ve `İ` karakterleri geçerli bir e-posta adresinde bulunmaz, bu yüzden
 * dönüşüm güvenlidir. Aynı adresin doğru biçimi zaten kayıtlıysa bozuk satır
 * silinir.
 */
async function repairTurkishLoweredEmails(db: D1Database) {
  if (!(await tableExists(db, "archive_users"))) return;
  const broken = await db.prepare("SELECT email FROM archive_users WHERE email LIKE '%ı%' OR email LIKE '%İ%'")
    .all<{ email: string }>();
  for (const row of broken.results) {
    const repaired = row.email.replaceAll("ı", "i").replaceAll("İ", "i");
    if (repaired === row.email) continue;
    const existing = await db.prepare("SELECT email FROM archive_users WHERE email = ?").bind(repaired).first<{ email: string }>();
    if (existing) {
      await db.prepare("DELETE FROM archive_users WHERE email = ?").bind(row.email).run();
    } else {
      await db.prepare("UPDATE archive_users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?")
        .bind(repaired, row.email).run();
    }
  }
}

export const SEARCH_REINDEX_TASK = "search-reindex";

/**
 * Sürüm 5–6: `search_text` kolonunun tek arama uygulamasıyla yenilenmesini
 * **kuyruğa alır**.
 *
 * Mevcut satırlar OCR servisindeki eski Python normalleştirmesiyle yazılmıştı;
 * sorgular artık `normalizeSearch` ile üretildiği için dizin de aynı fonksiyonla
 * yenilenmelidir. Ancak bütün arşivi göç isteğinin içinde dolaşmak büyük arşivde
 * zaman aşımına ve her denemede baştan başlamaya yol açar. Bu yüzden göç yalnız
 * işi kuyruğa alır; işleme `runMaintenanceSlice` ile sınırlı dilimler hâlinde
 * yapılır (bkz. `POST /api/admin/maintenance`).
 */
async function enqueueSearchReindex(db: D1Database) {
  if (!(await tableExists(db, "ocr_pages"))) return;
  const total = await db.prepare("SELECT COUNT(*) AS count FROM ocr_pages").first<{ count: number }>();
  await db.prepare(`INSERT INTO maintenance_tasks (id, status, cursor, processed, total)
    VALUES (?, 'PENDING', NULL, 0, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'PENDING', cursor = NULL, processed = 0, total = excluded.total,
      locked_until = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP`)
    .bind(SEARCH_REINDEX_TASK, Number(total?.count ?? 0)).run();
}

export type MaintenanceProgress = {
  task: string;
  status: string;
  processed: number;
  total: number | null;
  remaining: number | null;
  done: boolean;
};

type MaintenanceRow = {
  id: string; status: string; cursor: string | null; processed: number;
  total: number | null; locked_until: string | null;
};

export async function readMaintenanceProgress(db: D1Database, task = SEARCH_REINDEX_TASK): Promise<MaintenanceProgress | null> {
  const row = await db.prepare(`SELECT id, status, cursor, processed, total, locked_until
    FROM maintenance_tasks WHERE id = ?`).bind(task).first<MaintenanceRow>();
  if (!row) return null;
  const total = row.total === null ? null : Number(row.total);
  return {
    task: row.id,
    status: row.status,
    processed: Number(row.processed),
    total,
    remaining: total === null ? null : Math.max(0, total - Number(row.processed)),
    done: row.status === "DONE",
  };
}

/** Kilit süresi: bir dilim bu süre içinde bitmezse iş yeniden alınabilir. */
const MAINTENANCE_LOCK_SECONDS = 120;

/**
 * Bakım işinin bir dilimini işler ve ilerlemeyi kaydeder.
 *
 * Kilit, aynı işin eşzamanlı iki çalıştırmasını engeller; imleç kaldığı yerden
 * devam etmeyi sağlar. Bir dilim başarısız olursa ilerleme korunur ve iş
 * `FAILED` işaretlenir; yeniden çalıştırma baştan başlamaz.
 */
export async function runMaintenanceSlice(db: D1Database, options: { batchSize?: number; maxBatches?: number } = {}) {
  const batchSize = Math.min(Math.max(options.batchSize ?? 200, 1), 1000);
  const maxBatches = Math.min(Math.max(options.maxBatches ?? 5, 1), 50);

  const claimed = await db.prepare(`UPDATE maintenance_tasks
    SET status = 'RUNNING', locked_until = datetime('now', '+${MAINTENANCE_LOCK_SECONDS} seconds'),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('PENDING', 'RUNNING', 'FAILED')
      AND (locked_until IS NULL OR locked_until < datetime('now'))
    RETURNING id, status, cursor, processed, total, locked_until`)
    .bind(SEARCH_REINDEX_TASK).first<MaintenanceRow>();
  if (!claimed) {
    const progress = await readMaintenanceProgress(db);
    return { claimed: false, progress };
  }

  let cursor = claimed.cursor;
  let processed = Number(claimed.processed);
  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const pages = await db.prepare(`SELECT id, COALESCE(confirmed_text, full_text) AS text FROM ocr_pages
        WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT ?`)
        .bind(cursor, cursor, batchSize).all<{ id: string; text: string }>();
      if (!pages.results.length) {
        await db.prepare(`UPDATE maintenance_tasks SET status = 'DONE', locked_until = NULL,
          processed = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(processed, SEARCH_REINDEX_TASK).run();
        return { claimed: true, progress: await readMaintenanceProgress(db) };
      }
      await db.batch(pages.results.map((page) =>
        db.prepare("UPDATE ocr_pages SET search_text = ? WHERE id = ?").bind(normalizeSearch(page.text ?? ""), page.id)));
      cursor = pages.results[pages.results.length - 1].id;
      processed += pages.results.length;
      // İlerleme her dilimde kalıcılaşır: kesinti baştan başlatmaz.
      await db.prepare(`UPDATE maintenance_tasks SET cursor = ?, processed = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).bind(cursor, processed, SEARCH_REINDEX_TASK).run();
      if (pages.results.length < batchSize) {
        await db.prepare(`UPDATE maintenance_tasks SET status = 'DONE', locked_until = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(SEARCH_REINDEX_TASK).run();
        return { claimed: true, progress: await readMaintenanceProgress(db) };
      }
    }
    // Dilim sınırına ulaşıldı; iş sıradaki çağrıda devam eder.
    await db.prepare(`UPDATE maintenance_tasks SET status = 'PENDING', locked_until = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(SEARCH_REINDEX_TASK).run();
    return { claimed: true, progress: await readMaintenanceProgress(db) };
  } catch (error) {
    await db.prepare(`UPDATE maintenance_tasks SET status = 'FAILED', locked_until = NULL,
      last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(String(error instanceof Error ? error.message : error).slice(0, 500), SEARCH_REINDEX_TASK).run();
    throw error;
  }
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
/** Bir sözlüğü ve terimlerini yazar; var olan kayda dokunmaz. */
function vocabularyStatements(db: D1Database, vocabularies: typeof seedVocabularies) {
  const statements: D1PreparedStatement[] = [];
  for (const vocabulary of vocabularies) {
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
  return statements;
}

async function seedControlledVocabulariesAndProfiles(db: D1Database) {
  const statements: D1PreparedStatement[] = vocabularyStatements(db, seedVocabularies);

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
  for (const [table, expected] of Object.entries(SCHEMA_MANIFEST)) {
    const columns = await columnNames(db, table);
    const missing = expected.filter((column) => !columns.has(column));
    if (missing.length) {
      throw new Error(`Arşiv şeması eksik: ${table} tablosunda ${missing.join(", ")} kolonu bulunmuyor. `
        + `Göç adımı eksik olabilir; ${MIGRATE_HINT}`);
    }
  }
}

/**
 * Sürüme bağlı göç adımları. Her adım, hedef sürümünün altındaki her
 * veritabanında bir kez çalışır ve kendi içinde yeniden çalıştırılabilir olmalıdır.
 * Yeni bir alan/tablo eklerken burada yeni bir adım açılır ve
 * `ARCHIVE_SCHEMA_VERSION` artırılır.
 */
type MigrationStep = { version: number; run: (db: D1Database) => Promise<unknown> };

/**
 * Tablo oluşturmadan **önce** çalışan yapısal adımlar.
 *
 * Mevcut tabloları değiştirir veya yeniden kurar. `CREATE TABLE` toplu işleminden
 * önce çalışmalıdır: yeni tablolar bu tablolara yabancı anahtarla bağlanır.
 */
const structuralMigrations: MigrationStep[] = [
  // 1 → 2: `extracted_fields` çoklu değer modeline geçer.
  { version: 2, run: migrateExtractedFieldsToMultiValue },
  { version: 2, run: migrateOcrPageColumns },
  // 2 → 3: doğrulayan/doğrulama zamanı düzeltme alanlarından ayrılır.
  { version: 3, run: migrateFieldVerifierColumns },
  // 3 → 4: belge türü profili ve alan tanımı bağları.
  { version: 4, run: migrateProfileColumns },
  // 8 → 9: aktif parça sayacı mevcut kabul oturumlarına eklenir.
  { version: 9, run: migrateIngestSessionConcurrencyColumn },
  // 9 → 10: belge adı ve talep edilen tür kabul oturumunda korunur.
  { version: 10, run: migrateIngestSessionDocumentMetadata },
  // 10 → 11: parça slotları kira damgasıyla kurtarılabilir olur.
  { version: 11, run: migrateIngestSessionPartLease },
  // 11 → 12: ortak sayaç kirası yerine istek başına fencing kaydı.
  { version: 12, run: createUploadPartLeases },
  // 12 → 13: tür/ayrıştırıcı/tarayıcı kanıtı ve tarama işi.
  { version: 13, run: migrateContentScanEvidence },
  // 13 -> 14: conditional promotion and post-write full SHA verification.
  { version: 14, run: createPromotionEvidenceTables },
  // 14 → 15: bütünlük koşuları hızlı/tam profil ayrımı kazanır.
  { version: 15, run: migrateIntegrityRunProfile },
  // 15 → 16: çökme kurtarma kirası ve deterministik tarama su işaretleri.
  { version: 16, run: hardenIntegrityAndReconciliationRuns },
  // 16 → 17: bölümlü PDF erişim türevleri sayfa aralığı taşır.
  { version: 17, run: migrateBinaryObjectPageRange },
  // 17 → 18: segment kuşağı ve renderer kanıtı; profil yükseltmesi engellenmez.
  { version: 18, run: migrateDerivativeGenerationEvidence },
  // 18 → 19: eski anahtarların maskeli envanteri ve taşıma durumu.
  { version: 19, run: createLegacyKeyMigrationTable },
  // 19 → 20: eski kaynak için bekleme sonu ve ayrı tasfiye kanıtı.
  { version: 20, run: migrateLegacyKeyRetentionEvidence },
  // 20 → 21: tek kullanımlık bilet değişimi ve süreli görüntüleme oturumu.
  { version: 21, run: createAccessSessionTable },
  // 21 → 22: belge+sınıf bağı, kapalı amaç kodu ve değişmez bağlama tetikleyicileri.
  { version: 22, run: hardenAccessTicketBindings },
  // 22 → 23: kullanıcı/rol yönetimi değişmez denetim kaydı.
  { version: 23, run: createUserAdminEventTable },
  // 23 → 24: yönetim denetim kaydı müdürlük olaylarını da taşır.
  { version: 24, run: widenAdminEventTargets },
  // 25 → 26: yönetilebilir sözlükler denetim kaydına kendi eylem/hedef adlarını yazar.
  { version: 26, run: relaxAdminEventConstraints },
  // 26 → 27: ret gerekçesi alan kaydında da saklanır.
  { version: 27, run: migrateFieldRejectionReasonColumns },
  // 27 → 28: arşivleme tasnifi (dosya planı + saklama kuralı) belge kaydına eklenir.
  { version: 28, run: migrateArchiveClassificationColumns },
];

/**
 * Tablolar kurulduktan **sonra** çalışan veri adımları.
 *
 * Yeni tablolara yazan veya tam şemaya ihtiyaç duyan adımlar buraya girer.
 * Yapısal listede çalıştırıldıklarında henüz var olmayan tabloya yazmaya
 * çalışırlar.
 */
const dataMigrations: MigrationStep[] = [
  // 4 → 5: kimlik düzeltmesi.
  { version: 5, run: repairTurkishLoweredEmails },
  // 5 → 6: arama dizini yenilemesi bakım işine taşındı; göç yalnız kuyruğa alır.
  { version: 6, run: enqueueSearchReindex },
  // 6 → 7: otomatik OCR tüketimi için geri çekilme ve dead-letter alanları.
  { version: 7, run: migrateProcessingJobOperationsColumns },
  // 7 → 8: kabul tabloları kurulur; SHA tekilliği yetkili nesne envanterine taşınır.
  { version: 8, run: migrateOriginalShaUniqueness },
  // 8 → 9: tarama denemeleri ayrı, değiştirilemez alındılar olarak saklanır.
  { version: 9, run: migrateIngestReceiptHistory },
  // 24 → 25: ret gerekçeleri kontrollü sözlüğe taşındı.
  { version: 25, run: seedRejectionReasonVocabularies },
  // 27 → 28: dosya planı ve saklama kuralı sözlükleri (taslak) tohumlanır.
  { version: 28, run: seedClassificationVocabularies },
];

/**
 * Ret gerekçeleri kod içindeki sabit listeden `vocabulary_terms` tablosuna
 * taşındı; kurum kendi gerekçesini ekleyebilmeli ve kullanmadığını
 * pasifleştirebilmelidir.
 *
 * `ON CONFLICT DO NOTHING` ile yazılır: kurumun düzenlemesi geri alınmaz,
 * pasifleştirdiği terim yeniden etkinleşmez.
 */
async function seedRejectionReasonVocabularies(db: D1Database) {
  const vocabularies = seedVocabularies.filter((vocabulary) =>
    vocabulary.code === FIELD_REJECTION_VOCABULARY_CODE
    || vocabulary.code === RELATION_REJECTION_VOCABULARY_CODE);
  await db.batch(vocabularyStatements(db, vocabularies));
}

/**
 * Dosya planı ve saklama kuralı sözlükleri (design.md §9.5). Kayıtlar taslak
 * olarak işaretlidir; kurumun onaylı planı ayarlardan işlenir ve
 * `ON CONFLICT DO NOTHING` kurumun düzenlemesini geri almaz.
 */
async function seedClassificationVocabularies(db: D1Database) {
  const vocabularies = seedVocabularies.filter((vocabulary) =>
    vocabulary.code === FILE_PLAN_VOCABULARY_CODE
    || vocabulary.code === RETENTION_RULE_VOCABULARY_CODE);
  await db.batch(vocabularyStatements(db, vocabularies));
}

/** Sürüm sözleşmesi denetimi ve raporlama için birleşik liste. */
export const archiveMigrationSteps: MigrationStep[] = [...structuralMigrations, ...dataMigrations]
  .sort((left, right) => left.version - right.version);

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * İstek başında şemanın hazır olduğunu doğrular.
 *
 * Üretimde yalnız **doğrulama** yapılır: şema geride ise istek 503 ile reddedilir
 * ve göç yetkili uç noktadan çalıştırılır. Yerel geliştirmede kolaylık için göç
 * kendiliğinden uygulanır; bu ayrım bilinçlidir ve `localhost` ile sınırlıdır.
 *
 * Hazırsa `null`, değilse döndürülecek `Response` verir.
 */
export async function requireArchiveSchema(request: Request, db: D1Database): Promise<Response | null> {
  try {
    await assertSchemaReady(db);
    return null;
  } catch (error) {
    if (!(error instanceof SchemaNotReadyError)) throw error;
    if (!isLocalRequest(request)) return jsonError(error.message, 503);
    await applyArchiveMigrations(db);
    await assertSchemaReady(db);
    return null;
  }
}

/**
 * Yürürlükteki şema sürümünü okur. Tablo henüz yoksa `0` döner.
 *
 * Salt okunur ve ucuzdur; istek yolunda yalnız bu çalışır.
 */
/**
 * Yalnız "tablo yok" hatası şemanın henüz kurulmadığı anlamına gelir.
 *
 * Bağlantı, yetki veya bozulma hataları da yakalanıp `0` sayılırsa, gerçek
 * arıza "şema kurulmamış" gibi görünür ve yerelde gereksiz DDL denenir.
 */
function isMissingTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

export async function readSchemaVersion(db: D1Database): Promise<number> {
  try {
    const state = await db.prepare("SELECT version FROM schema_state WHERE id = 'archive'").first<{ version: number }>();
    return Number(state?.version ?? 0);
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
}

export class SchemaNotReadyError extends Error {
  // Kısayol "parameter property" sözdizimi kullanılmaz: saf mantık modülleri
  // `node --test` ile tür sıyırma modunda çalıştırılır ve o sözdizimi desteklenmez.
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super(`Arşiv şeması ${currentVersion} sürümünde; ${ARCHIVE_SCHEMA_VERSION} bekleniyor. ${MIGRATE_HINT}`);
    this.name = "SchemaNotReadyError";
    this.currentVersion = currentVersion;
  }
}

/** İstek yolunda kullanılır: şema geride ise açık hata verir, DDL çalıştırmaz. */
export async function assertSchemaReady(db: D1Database) {
  const current = await readSchemaVersion(db);
  if (current !== ARCHIVE_SCHEMA_VERSION) throw new SchemaNotReadyError(current);
}

/**
 * Şemayı oluşturur ve göçleri uygular. **Değiştirici işlem.**
 *
 * Bir istek işlenirken çalıştırılmaz: yetkili göç uç noktası veya yerel
 * geliştirme dışında çağrılmamalıdır. Sıradan bir okuma isteğinin şema
 * değiştirebilmesi, hem yetki modelini hem de eşzamanlı dağıtım güvenliğini
 * zedeler.
 */
export async function applyArchiveMigrations(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_state (
    id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  const current = await readSchemaVersion(db);
  if (current === ARCHIVE_SCHEMA_VERSION) return { applied: false, from: current, to: ARCHIVE_SCHEMA_VERSION };

  // Sıra önemlidir: `extracted_fields` yeniden kurulmadan ona yabancı anahtarla
  // bağlanan `document_entity_relations` oluşturulmamalıdır.
  for (const migration of structuralMigrations) {
    if (current < migration.version) await migration.run(db);
  }

  await db.batch(tableStatements.map((statement) => db.prepare(statement)));

  // Veri adımları tam şemaya ihtiyaç duyar; tablolardan sonra çalışır.
  for (const migration of dataMigrations) {
    if (current < migration.version) await migration.run(db);
  }

  await backfillOriginalObjects(db);
  await seedControlledVocabulariesAndProfiles(db);
  await backfillProfileLinks(db);
  await assertExpectedColumns(db);

  await db.prepare(`INSERT INTO schema_state (id, version, updated_at) VALUES ('archive', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = CURRENT_TIMESTAMP`)
    .bind(ARCHIVE_SCHEMA_VERSION).run();
  return { applied: true, from: current, to: ARCHIVE_SCHEMA_VERSION };
}
