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

/** Faz 1 kabul hattı — `lib/ingest-schema.ts` DDL tanımının Drizzle tip aynası. */
export const uploadSessions = sqliteTable("upload_sessions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default("default"),
  userId: text("user_id").notNull(),
  unit: text("unit").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("CREATED"),
  stateVersion: integer("state_version").notNull().default(0),
  expectedByteSize: integer("expected_byte_size").notNull(),
  uploadedByteSize: integer("uploaded_byte_size").notNull().default(0),
  declaredMediaType: text("declared_media_type").notNull(),
  detectedMediaType: text("detected_media_type"),
  providerUploadToken: text("provider_upload_token"),
  duplicateOfDocumentId: text("duplicate_of_document_id").references(() => archiveDocuments.id),
  failureCode: text("failure_code"),
  operatorRetryReason: text("operator_retry_reason"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("upload_sessions_idempotency_unique").on(table.tenantId, table.userId, table.idempotencyKey),
  index("upload_sessions_status_expiry_idx").on(table.status, table.expiresAt),
  check("upload_sessions_status_check", sql`${table.status} IN ('CREATED', 'UPLOADING', 'QUARANTINED', 'SCANNING', 'VERIFIED', 'PROMOTING', 'ACCEPTED', 'REJECTED', 'DUPLICATE', 'EXPIRED', 'FAILED')`),
  check("upload_sessions_state_version_check", sql`${table.stateVersion} >= 0`),
  check("upload_sessions_expected_size_check", sql`${table.expectedByteSize} BETWEEN 1 AND 2147483648`),
  check("upload_sessions_uploaded_size_check", sql`${table.uploadedByteSize} BETWEEN 0 AND ${table.expectedByteSize}`),
  check("upload_sessions_duplicate_check", sql`(${table.status} = 'DUPLICATE' AND ${table.duplicateOfDocumentId} IS NOT NULL) OR ${table.status} <> 'DUPLICATE'`),
]);

export const uploadParts = sqliteTable("upload_parts", {
  id: text("id").primaryKey(),
  uploadSessionId: text("upload_session_id").notNull().references(() => uploadSessions.id, { onDelete: "cascade" }),
  partNumber: integer("part_number").notNull(),
  byteSize: integer("byte_size").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  providerPartToken: text("provider_part_token").notNull(),
  status: text("status").notNull().default("UPLOADED"),
  attemptCount: integer("attempt_count").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("upload_parts_session_number_unique").on(table.uploadSessionId, table.partNumber),
  index("upload_parts_session_status_idx").on(table.uploadSessionId, table.status),
  check("upload_parts_number_check", sql`${table.partNumber} BETWEEN 1 AND 10000`),
  check("upload_parts_size_check", sql`${table.byteSize} > 0`),
  check("upload_parts_checksum_check", sql`length(${table.checksumSha256}) = 64`),
  check("upload_parts_status_check", sql`${table.status} IN ('UPLOADED', 'VERIFIED', 'REPLACED', 'FAILED')`),
  check("upload_parts_attempt_check", sql`${table.attemptCount} >= 1`),
]);

export const ingestObjects = sqliteTable("ingest_objects", {
  id: text("id").primaryKey(),
  uploadSessionId: text("upload_session_id").notNull().references(() => uploadSessions.id, { onDelete: "cascade" }),
  objectClass: text("object_class").notNull(),
  objectKey: text("object_key").notNull().unique(),
  storageProvider: text("storage_provider").notNull(),
  bucketOrNamespace: text("bucket_or_namespace").notNull(),
  storageVersionId: text("storage_version_id"),
  providerEtag: text("provider_etag"),
  mediaType: text("media_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: text("deleted_at"),
}, (table) => [
  uniqueIndex("ingest_objects_session_class_unique").on(table.uploadSessionId, table.objectClass).where(sql`deleted_at IS NULL`),
  index("ingest_objects_class_created_idx").on(table.objectClass, table.createdAt),
  check("ingest_objects_class_check", sql`${table.objectClass} IN ('temporary', 'quarantine')`),
  check("ingest_objects_size_check", sql`${table.byteSize} >= 0`),
  check("ingest_objects_hash_check", sql`${table.sha256} IS NULL OR length(${table.sha256}) = 64`),
]);

export const ingestReceipts = sqliteTable("ingest_receipts", {
  id: text("id").primaryKey(),
  uploadSessionId: text("upload_session_id").notNull().references(() => uploadSessions.id, { onDelete: "cascade" }),
  result: text("result").notNull(),
  sha256: text("sha256").notNull(),
  byteSize: integer("byte_size").notNull(),
  declaredMediaType: text("declared_media_type").notNull(),
  detectedMediaType: text("detected_media_type").notNull(),
  typeValidationResult: text("type_validation_result").notNull(),
  scannerEngine: text("scanner_engine").notNull(),
  scannerVersion: text("scanner_version").notNull(),
  scannerSignatureVersion: text("scanner_signature_version").notNull(),
  scannerResult: text("scanner_result").notNull(),
  vaultStorageVersionId: text("vault_storage_version_id"),
  vaultSha256: text("vault_sha256"),
  verifiedAt: text("verified_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ingest_receipts_session_unique").on(table.uploadSessionId),
  index("ingest_receipts_result_created_idx").on(table.result, table.createdAt),
  check("ingest_receipts_result_check", sql`${table.result} IN ('VERIFIED', 'REJECTED', 'FAILED')`),
  check("ingest_receipts_hash_check", sql`length(${table.sha256}) = 64`),
  check("ingest_receipts_size_check", sql`${table.byteSize} > 0`),
  check("ingest_receipts_type_check", sql`${table.typeValidationResult} IN ('MATCH', 'MISMATCH', 'UNSUPPORTED')`),
  check("ingest_receipts_scanner_check", sql`${table.scannerResult} IN ('CLEAN', 'MALICIOUS', 'ERROR')`),
  check("ingest_receipts_vault_hash_check", sql`${table.vaultSha256} IS NULL OR length(${table.vaultSha256}) = 64`),
]);

export const integrityRuns = sqliteTable("integrity_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("RUNNING"),
  cursor: text("cursor"),
  checkedCount: integer("checked_count").notNull().default(0),
  findingCount: integer("finding_count").notNull().default(0),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [
  index("integrity_runs_status_started_idx").on(table.status, table.startedAt),
  check("integrity_runs_status_check", sql`${table.status} IN ('RUNNING', 'COMPLETED', 'FAILED')`),
  check("integrity_runs_checked_check", sql`${table.checkedCount} >= 0`),
  check("integrity_runs_finding_check", sql`${table.findingCount} >= 0`),
]);

export const integrityFindings = sqliteTable("integrity_findings", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => integrityRuns.id, { onDelete: "cascade" }),
  binaryObjectId: text("binary_object_id").references(() => binaryObjects.id, { onDelete: "set null" }),
  objectKey: text("object_key").notNull(),
  findingType: text("finding_type").notNull(),
  expectedSha256: text("expected_sha256"),
  actualSha256: text("actual_sha256"),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("OPEN"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: text("resolved_at"),
}, (table) => [
  index("integrity_findings_run_status_idx").on(table.runId, table.status),
  index("integrity_findings_object_idx").on(table.binaryObjectId),
  check("integrity_findings_type_check", sql`${table.findingType} IN ('MISSING', 'SIZE_MISMATCH', 'HASH_MISMATCH', 'UNREADABLE')`),
  check("integrity_findings_severity_check", sql`${table.severity} IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')`),
  check("integrity_findings_status_check", sql`${table.status} IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')`),
]);

export const reconciliationRuns = sqliteTable("reconciliation_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("RUNNING"),
  cursor: text("cursor"),
  checkedCount: integer("checked_count").notNull().default(0),
  findingCount: integer("finding_count").notNull().default(0),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [
  index("reconciliation_runs_status_started_idx").on(table.status, table.startedAt),
  check("reconciliation_runs_status_check", sql`${table.status} IN ('RUNNING', 'COMPLETED', 'FAILED')`),
  check("reconciliation_runs_checked_check", sql`${table.checkedCount} >= 0`),
  check("reconciliation_runs_finding_check", sql`${table.findingCount} >= 0`),
]);

export const reconciliationFindings = sqliteTable("reconciliation_findings", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => reconciliationRuns.id, { onDelete: "cascade" }),
  recordKind: text("record_kind").notNull(),
  recordId: text("record_id"),
  objectKey: text("object_key"),
  findingType: text("finding_type").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("OPEN"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: text("resolved_at"),
}, (table) => [
  index("reconciliation_findings_run_status_idx").on(table.runId, table.status),
  check("reconciliation_findings_kind_check", sql`${table.recordKind} IN ('INGEST_OBJECT', 'BINARY_OBJECT', 'ARCHIVE_DOCUMENT', 'STORAGE_OBJECT')`),
  check("reconciliation_findings_type_check", sql`${table.findingType} IN ('ORPHAN_OBJECT', 'MISSING_OBJECT', 'MISSING_RECORD', 'METADATA_MISMATCH')`),
  check("reconciliation_findings_severity_check", sql`${table.severity} IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')`),
  check("reconciliation_findings_status_check", sql`${table.status} IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')`),
  check("reconciliation_findings_reference_check", sql`${table.recordId} IS NOT NULL OR ${table.objectKey} IS NOT NULL`),
]);

export const accessTickets = sqliteTable("access_tickets", {
  id: text("id").primaryKey(),
  ticketHash: text("ticket_hash").notNull().unique(),
  userId: text("user_id").notNull(),
  binaryObjectId: text("binary_object_id").notNull().references(() => binaryObjects.id, { onDelete: "cascade" }),
  scope: text("scope").notNull(),
  purpose: text("purpose").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("access_tickets_user_expiry_idx").on(table.userId, table.expiresAt),
  index("access_tickets_object_idx").on(table.binaryObjectId),
  check("access_tickets_scope_check", sql`${table.scope} IN ('VIEW', 'DOWNLOAD')`),
  check("access_tickets_hash_check", sql`length(${table.ticketHash}) = 64`),
  check("access_tickets_purpose_check", sql`length(trim(${table.purpose})) > 0`),
]);
export const uploadSessionEvents = sqliteTable("upload_session_events", {
  id: text("id").primaryKey(),
  uploadSessionId: text("upload_session_id").notNull().references(() => uploadSessions.id, { onDelete: "cascade" }),
  eventNumber: integer("event_number").notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  actorKind: text("actor_kind").notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason"),
  ingestReceiptId: text("ingest_receipt_id").references(() => ingestReceipts.id),
  eventHash: text("event_hash").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("upload_session_events_number_unique").on(table.uploadSessionId, table.eventNumber),
  index("upload_session_events_transition_idx").on(table.fromStatus, table.toStatus, table.createdAt),
  check("upload_session_events_number_check", sql`${table.eventNumber} >= 1`),
  check("upload_session_events_actor_check", sql`${table.actorKind} IN ('user', 'operator', 'service')`),
  check("upload_session_events_actor_id_check", sql`length(trim(${table.actorId})) > 0`),
  check("upload_session_events_hash_check", sql`length(${table.eventHash}) = 64`),
  check("upload_session_events_retry_check", sql`${table.fromStatus} <> 'FAILED' OR ${table.toStatus} <> 'PROMOTING' OR (${table.actorKind} = 'operator' AND length(trim(${table.reason})) > 0 AND ${table.ingestReceiptId} IS NOT NULL)`),
]);
