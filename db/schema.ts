import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Drizzle şema aynası.
 *
 * Yetkili DDL kaynağı `lib/archive-schema.ts` dosyasıdır. Bu dosya yalnız tip
 * tanımı ve kısıt niyetinin okunabilir kaydıdır; hiçbir sorgu buradan üretilmez
 * (`db/index.ts` içindeki Drizzle istemcisi kullanılmıyor). İki tanımın kolon
 * düzeyinde ayrışması `tests/schema-contract.test.ts` ile engellenir: bir tabloya
 * kolon eklerken **her iki dosya** güncellenmelidir.
 */

export const archiveDocuments = sqliteTable("archive_documents", {
  id: text("id").primaryKey(),
  referenceNo: text("reference_no").notNull().unique(),
  originalName: text("original_name").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  mediaType: text("media_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  documentType: text("document_type").notNull().default("Tasnif bekliyor"),
  documentTypeId: text("document_type_id"),
  documentProfileVersion: text("document_profile_version"),
  unit: text("unit").notNull().default("Belirlenmedi"),
  status: text("status").notNull().default("queued"),
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("archive_documents_sha256_unique").on(table.sha256),
  index("archive_documents_status_idx").on(table.status),
  index("archive_documents_created_at_idx").on(table.createdAt),
  index("archive_documents_profile_idx").on(table.documentTypeId),
  index("archive_documents_created_id_idx").on(table.createdAt, table.id),
  index("archive_documents_status_created_id_idx").on(table.status, table.createdAt, table.id),
]);

/** VERI_SOZLUGU.md §13: kontrollü sözlükler. */
export const vocabularies = sqliteTable("vocabularies", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  owner: text("owner").notNull(),
  source: text("source").notNull(),
  version: text("version").notNull(),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const vocabularyTerms = sqliteTable("vocabulary_terms", {
  id: text("id").primaryKey(),
  vocabularyId: text("vocabulary_id").notNull().references(() => vocabularies.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("vocabulary_terms_code_unique").on(table.vocabularyId, table.code),
  index("vocabulary_terms_active_idx").on(table.vocabularyId, table.active, table.sortOrder),
]);

/** VERI_SOZLUGU.md §6 ve ADR-008: sürümlü belge türü profilleri. */
export const documentTypes = sqliteTable("document_types", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  ownerDepartment: text("owner_department").notNull().default("Belirlenmedi"),
  profileVersion: text("profile_version").notNull(),
  profileStatus: text("profile_status").notNull().default("HYPOTHESIS"),
  detectionMarkersJson: text("detection_markers_json").notNull().default("[]"),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("document_types_code_version_unique").on(table.code, table.profileVersion),
  index("document_types_name_idx").on(table.name),
  index("document_types_status_idx").on(table.profileStatus),
  check("document_types_status_check", sql`${table.profileStatus} IN ('HYPOTHESIS', 'DISCOVERED', 'VALIDATED', 'PILOT', 'ACTIVE', 'RETIRED')`),
]);

/** VERI_SOZLUGU.md §6: alan tanımları profil sürümüne bağlıdır. */
export const fieldDefinitions = sqliteTable("field_definitions", {
  id: text("id").primaryKey(),
  documentTypeId: text("document_type_id").notNull().references(() => documentTypes.id, { onDelete: "cascade" }),
  fieldCode: text("field_code").notNull(),
  label: text("label").notNull(),
  dataType: text("data_type").notNull().default("TEXT"),
  cardinality: text("cardinality").notNull().default("one"),
  requirement: text("requirement").notNull().default("OPTIONAL"),
  isCritical: integer("is_critical", { mode: "boolean" }).notNull().default(false),
  extractionPolicy: text("extraction_policy").notNull().default("SUGGEST"),
  formatPattern: text("format_pattern"),
  formatHint: text("format_hint"),
  vocabularyCode: text("vocabulary_code"),
  enforceVocabulary: integer("enforce_vocabulary", { mode: "boolean" }).notNull().default(false),
  entityType: text("entity_type"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("field_definitions_type_code_unique").on(table.documentTypeId, table.fieldCode),
  index("field_definitions_type_order_idx").on(table.documentTypeId, table.sortOrder),
  check("field_definitions_data_type_check", sql`${table.dataType} IN ('TEXT', 'DATE', 'IDENTIFIER', 'CODE', 'ENTITY_REF')`),
  check("field_definitions_cardinality_check", sql`${table.cardinality} IN ('one', 'zero_or_one', 'one_or_more', 'many')`),
  check("field_definitions_requirement_check", sql`${table.requirement} IN ('OPTIONAL', 'REQUIRED', 'REQUIRED_FOR_ARCHIVE')`),
  check("field_definitions_extraction_check", sql`${table.extractionPolicy} IN ('NONE', 'SUGGEST', 'VERIFY_REQUIRED')`),
  // ADR-006: kritik alanda insan onayı her durumda zorunludur.
  check("field_definitions_critical_verify_check", sql`${table.isCritical} = 0 OR ${table.extractionPolicy} = 'VERIFY_REQUIRED'`),
  check("field_definitions_pattern_length_check", sql`length(${table.formatPattern}) <= 400`),
]);

/** S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5 ve §8: nesne sınıfları ve nesne kaydı. */
export const binaryObjects = sqliteTable("binary_objects", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => archiveDocuments.id, { onDelete: "cascade" }),
  objectClass: text("object_class").notNull(),
  objectKey: text("object_key").notNull().unique(),
  storageProvider: text("storage_provider").notNull().default("r2"),
  bucketOrNamespace: text("bucket_or_namespace").notNull().default("ARCHIVE_FILES"),
  storageVersionId: text("storage_version_id"),
  mediaType: text("media_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  encryptionStatus: text("encryption_status").notNull().default("provider-managed"),
  derivedFromId: text("derived_from_id"),
  generator: text("generator"),
  retentionStatus: text("retention_status").notNull().default("ACTIVE"),
  legalHoldStatus: text("legal_hold_status").notNull().default("NONE"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("binary_objects_document_class_idx").on(table.documentId, table.objectClass),
  index("binary_objects_sha256_idx").on(table.sha256),
  uniqueIndex("binary_objects_single_original_unique").on(table.documentId).where(sql`object_class = 'original'`),
  check("binary_objects_class_check", sql`${table.objectClass} IN ('original', 'access', 'ocr', 'preservation', 'thumbnail', 'quarantine', 'temporary')`),
  check("binary_objects_retention_check", sql`${table.retentionStatus} IN ('ACTIVE', 'RETENTION_REVIEW', 'DISPOSED')`),
  check("binary_objects_hold_check", sql`${table.legalHoldStatus} IN ('NONE', 'HELD')`),
  check("binary_objects_size_check", sql`${table.byteSize} >= 0`),
  check("binary_objects_self_reference_check", sql`${table.id} <> ${table.derivedFromId}`),
]);

export const processingJobs = sqliteTable("processing_jobs", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => archiveDocuments.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("ocr"),
  status: text("status").notNull().default("queued"),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  model: text("model").notNull().default("paddleocr-local"),
  errorMessage: text("error_message"),
  nextAttemptAt: text("next_attempt_at"),
  lastAttemptAt: text("last_attempt_at"),
  deadLetteredAt: text("dead_lettered_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("processing_jobs_status_created_idx").on(table.status, table.createdAt),
  index("processing_jobs_schedule_idx").on(table.status, table.nextAttemptAt, table.createdAt),
  index("processing_jobs_document_idx").on(table.documentId),
]);

export const ocrPages = sqliteTable("ocr_pages", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => archiveDocuments.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  rawText: text("raw_text").notNull().default(""),
  fullText: text("full_text").notNull().default(""),
  searchText: text("search_text").notNull().default(""),
  confirmedText: text("confirmed_text"),
  confirmedBy: text("confirmed_by"),
  confirmedAt: text("confirmed_at"),
  wordsJson: text("words_json").notNull().default("[]"),
  averageConfidence: real("average_confidence").notNull().default(0),
  model: text("model").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ocr_pages_document_page_unique").on(table.documentId, table.pageNumber),
  index("ocr_pages_document_idx").on(table.documentId),
]);

export const textRevisions = sqliteTable("text_revisions", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => archiveDocuments.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  previousSha256: text("previous_sha256").notNull(),
  textSha256: text("text_sha256").notNull(),
  revisedText: text("revised_text").notNull(),
  actor: text("actor").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("text_revisions_document_page_revision_unique").on(table.documentId, table.pageNumber, table.revisionNumber),
  index("text_revisions_document_created_idx").on(table.documentId, table.createdAt),
]);

/**
 * VERI_SOZLUGU.md §8: aynı belge ve alan için birden fazla değer bulunabilir.
 * Tek değer varsayımı uygulayan eski `UNIQUE(document_id, field_name)` indeksi
 * kaldırılmış, yerine sıra koruyan `value_index` üçlüsü gelmiştir.
 */
export const extractedFields = sqliteTable("extracted_fields", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => archiveDocuments.id, { onDelete: "cascade" }),
  fieldName: text("field_name").notNull(),
  fieldDefinitionId: text("field_definition_id").references(() => fieldDefinitions.id),
  valueIndex: integer("value_index").notNull().default(0),
  fieldValue: text("field_value").notNull(),
  normalizedValue: text("normalized_value"),
  confidence: real("confidence").notNull(),
  riskLevel: text("risk_level").notNull().default("MEDIUM"),
  pageNumber: integer("page_number").notNull(),
  bboxJson: text("bbox_json").notNull(),
  evidenceText: text("evidence_text").notNull(),
  model: text("model").notNull(),
  vocabularyVersion: text("vocabulary_version"),
  verificationStatus: text("verification_status").notNull().default("SUGGESTED"),
  origin: text("origin").notNull().default("OCR"),
  verifiedBy: text("verified_by"),
  verifiedAt: text("verified_at"),
  correctedValue: text("corrected_value"),
  correctedBy: text("corrected_by"),
  correctedAt: text("corrected_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("extracted_fields_document_field_value_unique").on(table.documentId, table.fieldName, table.valueIndex),
  index("extracted_fields_document_idx").on(table.documentId),
  index("extracted_fields_status_idx").on(table.verificationStatus),
  check("extracted_fields_verification_check", sql`${table.verificationStatus} IN ('SUGGESTED', 'CONFIRMED', 'CORRECTED', 'REJECTED')`),
  check("extracted_fields_risk_check", sql`${table.riskLevel} IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')`),
  check("extracted_fields_origin_check", sql`${table.origin} IN ('OCR', 'HUMAN')`),
  check("extracted_fields_value_index_check", sql`${table.valueIndex} >= 0`),
]);

/**
 * VERI_SOZLUGU.md §9: ortak varlık çekirdeği. `PERSON`/`ORGANIZATION` türleri
 * hukuk/KVKK veri envanteri tamamlanana kadar kapsam dışıdır.
 */
export const entities = sqliteTable("entities", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  displayLabel: text("display_label").notNull(),
  authoritySource: text("authority_source").notNull().default("ARCHIVE"),
  externalId: text("external_id"),
  entityStatus: text("entity_status").notNull().default("PROVISIONAL"),
  mergedIntoId: text("merged_into_id"),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("entities_authority_external_unique").on(table.authoritySource, table.entityType, table.externalId),
  index("entities_type_status_idx").on(table.entityType, table.entityStatus),
  check("entities_type_check", sql`${table.entityType} IN ('PARCEL', 'ADDRESS', 'BUILDING', 'BUILDING_UNIT')`),
  check("entities_status_check", sql`${table.entityStatus} IN ('PROVISIONAL', 'ACTIVE', 'HISTORICAL', 'MERGED')`),
  check("entities_merge_check", sql`${table.id} <> ${table.mergedIntoId}`),
]);

/** VERI_SOZLUGU.md §9.1: ada/parsel metindir, hukuki ekler korunur. */
export const parcelEntities = sqliteTable("parcel_entities", {
  entityId: text("entity_id").primaryKey().references(() => entities.id, { onDelete: "cascade" }),
  parcelExternalId: text("parcel_external_id"),
  districtCode: text("district_code").notNull().default("UNKNOWN"),
  cadastralNeighborhood: text("cadastral_neighborhood").notNull().default("UNKNOWN"),
  blockNo: text("block_no").notNull(),
  parcelNo: text("parcel_no").notNull(),
  geometryVersion: text("geometry_version"),
  parcelStatus: text("parcel_status").notNull().default("UNKNOWN"),
}, (table) => [
  uniqueIndex("parcel_entities_identity_unique").on(table.districtCode, table.cadastralNeighborhood, table.blockNo, table.parcelNo),
  index("parcel_entities_block_parcel_idx").on(table.blockNo, table.parcelNo),
  check("parcel_entities_block_check", sql`length(${table.blockNo}) > 0`),
  check("parcel_entities_parcel_check", sql`length(${table.parcelNo}) > 0`),
]);

/** VERI_SOZLUGU.md §9.2. */
export const addressEntities = sqliteTable("address_entities", {
  entityId: text("entity_id").primaryKey().references(() => entities.id, { onDelete: "cascade" }),
  addressExternalId: text("address_external_id"),
  nationalAddressId: text("national_address_id"),
  neighborhood: text("neighborhood").notNull().default("UNKNOWN"),
  street: text("street").notNull().default("UNKNOWN"),
  doorNo: text("door_no").notNull().default("UNKNOWN"),
  unitNo: text("unit_no").notNull().default(""),
  normalizedAddress: text("normalized_address").notNull(),
  pointGeometry: text("point_geometry"),
}, (table) => [
  uniqueIndex("address_entities_identity_unique").on(table.neighborhood, table.street, table.doorNo, table.unitNo),
  index("address_entities_normalized_idx").on(table.normalizedAddress),
]);

/** VERI_SOZLUGU.md §9.3. */
export const buildingEntities = sqliteTable("building_entities", {
  entityId: text("entity_id").primaryKey().references(() => entities.id, { onDelete: "cascade" }),
  buildingExternalId: text("building_external_id"),
  buildingLabel: text("building_label").notNull(),
  parcelEntityId: text("parcel_entity_id"),
  buildingGeometry: text("building_geometry"),
  unitLabel: text("unit_label"),
}, (table) => [
  index("building_entities_parcel_idx").on(table.parcelEntityId),
]);

/** VERI_SOZLUGU.md §10: belge-varlık ilişkisi, kaynağı ve doğrulama durumu. */
export const documentEntityRelations = sqliteTable("document_entity_relations", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => archiveDocuments.id, { onDelete: "cascade" }),
  entityId: text("entity_id").notNull().references(() => entities.id),
  relationType: text("relation_type").notNull(),
  relationSource: text("relation_source").notNull(),
  relationConfidence: real("relation_confidence"),
  verificationStatus: text("verification_status").notNull().default("SUGGESTED"),
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  evidenceJson: text("evidence_json").notNull().default("{}"),
  extractedFieldId: text("extracted_field_id").references(() => extractedFields.id, { onDelete: "set null" }),
  verifiedBy: text("verified_by"),
  verifiedAt: text("verified_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("document_entity_relations_unique").on(table.documentId, table.entityId, table.relationType),
  index("document_entity_relations_document_idx").on(table.documentId),
  index("document_entity_relations_entity_idx").on(table.entityId, table.verificationStatus),
  check("document_entity_relations_type_check", sql`${table.relationType} IN ('SUBJECT', 'AFFECTS', 'ATTACHMENT_REFERENCE', 'NEIGHBOR', 'PARTY', 'HISTORICAL_LINK', 'SPATIAL_INTERSECTION', 'TEXT_MENTION')`),
  check("document_entity_relations_source_check", sql`${table.relationSource} IN ('GIS', 'HUMAN', 'OCR', 'INTEGRATION', 'SPATIAL')`),
  check("document_entity_relations_verification_check", sql`${table.verificationStatus} IN ('SUGGESTED', 'VERIFIED', 'REJECTED')`),
  check("document_entity_relations_verifier_check", sql`${table.verificationStatus} <> 'VERIFIED' OR ${table.verifiedBy} IS NOT NULL`),
]);

/** VERI_SOZLUGU.md §11 ve ADR-011: ifraz/tevhit eski kaydı ezmez. */
export const parcelLineage = sqliteTable("parcel_lineage", {
  id: text("id").primaryKey(),
  predecessorParcelId: text("predecessor_parcel_id").notNull().references(() => entities.id),
  successorParcelId: text("successor_parcel_id").notNull().references(() => entities.id),
  lineageEventType: text("lineage_event_type").notNull(),
  eventDate: text("event_date"),
  sourceReference: text("source_reference"),
  verificationStatus: text("verification_status").notNull().default("SUGGESTED"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("parcel_lineage_unique").on(table.predecessorParcelId, table.successorParcelId, table.lineageEventType),
  index("parcel_lineage_predecessor_idx").on(table.predecessorParcelId),
  index("parcel_lineage_successor_idx").on(table.successorParcelId),
  check("parcel_lineage_event_check", sql`${table.lineageEventType} IN ('SUBDIVISION', 'MERGE', 'RENUMBER', 'BOUNDARY_CORRECTION', 'OTHER')`),
  check("parcel_lineage_verification_check", sql`${table.verificationStatus} IN ('SUGGESTED', 'VERIFIED', 'REJECTED')`),
  check("parcel_lineage_distinct_check", sql`${table.predecessorParcelId} <> ${table.successorParcelId}`),
]);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull().references(() => archiveDocuments.id, { onDelete: "cascade" }),
  eventNumber: integer("event_number").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  detailsJson: text("details_json").notNull().default("{}"),
  previousHash: text("previous_hash"),
  eventHash: text("event_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("audit_events_document_number_unique").on(table.documentId, table.eventNumber),
  uniqueIndex("audit_events_hash_unique").on(table.eventHash),
  index("audit_events_document_created_idx").on(table.documentId, table.createdAt),
]);

export const archiveUsers = sqliteTable("archive_users", {
  email: text("email").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("viewer"),
  unit: text("unit").notNull().default("*"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("archive_users_role_idx").on(table.role),
  index("archive_users_unit_idx").on(table.unit),
]);

/**
 * Uzun süren bakım işleri (arama dizini yenilemesi gibi). Bütün arşivi dolaşan
 * iş göç adımının içinde çalıştırılmaz; kilitli ve imleçli olarak dilimlenir.
 */
export const maintenanceTasks = sqliteTable("maintenance_tasks", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("PENDING"),
  cursor: text("cursor"),
  processed: integer("processed").notNull().default(0),
  total: integer("total"),
  lockedUntil: text("locked_until"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("maintenance_tasks_status_idx").on(table.status),
  check("maintenance_tasks_status_check", sql`${table.status} IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')`),
  check("maintenance_tasks_processed_check", sql`${table.processed} >= 0`),
]);

/** `lib/archive-schema.ts` sürüm kapısı tablosu. */
export const schemaState = sqliteTable("schema_state", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
