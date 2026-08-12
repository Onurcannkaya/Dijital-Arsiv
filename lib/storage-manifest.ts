/**
 * F1.10 / ADR-017 — Sağlayıcıdan bağımsız taşınabilir belge paketi.
 *
 * Paket; mantıksal kimlikler, nesne sınıfı/boyut/medya türü/SHA-256 manifesti,
 * belge üst verisi ve profil sürümü, doğrulanmış varlık ilişkileri, OCR metin
 * bağlamı ve denetim zincirinin doğrulama bölümünü taşır. Sağlayıcı anahtarı,
 * ETag ve sürüm kimliği pakete BİLİNÇLİ olarak girmez. Nesne bütünlüğü içerik
 * SHA-256 ile, paket özgünlüğü ise paket dışındaki güvenilir manifest özetiyle
 * doğrulanır (ADR-017). Manifest kanonik JSON'dur; aynı veri her çalıştırmada
 * bayt-bayt aynı manifesti üretir.
 */

import { digestToHex, type StreamingHasher } from "./content-hasher.ts";
import { ARCHIVE_SCHEMA_VERSION } from "./archive-schema.ts";
import type { ImmutableVaultWriter, ObjectReader, StagingStorage } from "./object-storage.ts";
import { normalizeSearch } from "./text-search.ts";

export const PORTABLE_PACKAGE_VERSION = "portable-package-v2";
export const MAX_PORTABLE_MANIFEST_BYTES = 16 * 1024 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OBJECT_CLASSES = new Set([
  "original", "access", "ocr", "preservation", "thumbnail",
]);

export type ManifestObject = {
  id: string;
  objectClass: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  pageStart: number | null;
  pageEnd: number | null;
  derivedFromId: string | null;
  generator: string | null;
  derivativeGenerationId: string | null;
  retentionStatus: string;
  legalHoldStatus: string;
  createdAt: string;
};

export type ManifestEntityAttributes =
  | { kind: "PARCEL"; parcelExternalId: string | null; districtCode: string;
      cadastralNeighborhood: string; blockNo: string; parcelNo: string;
      geometryVersion: string | null; parcelStatus: string }
  | { kind: "ADDRESS"; addressExternalId: string | null; nationalAddressId: string | null;
      neighborhood: string; street: string; doorNo: string; unitNo: string;
      normalizedAddress: string; pointGeometry: string | null }
  | { kind: "BUILDING"; buildingExternalId: string | null; buildingLabel: string;
      parcelEntityId: string | null; buildingGeometry: string | null; unitLabel: string | null }
  | { kind: "BUILDING_UNIT" };

export type ManifestRelation = {
  id: string;
  relationType: string;
  relationSource: string;
  verificationStatus: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  entity: {
    id: string;
    entityType: string;
    displayLabel: string;
    authoritySource: string;
    externalId: string | null;
    entityStatus: string;
    attributes: ManifestEntityAttributes;
  };
};

export type ManifestOcrPage = {
  pageNumber: number;
  width: number;
  height: number;
  model: string;
  averageConfidence: number;
  fullText: string;
  confirmedText: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
};

export type ManifestAuditEvent = {
  id: string;
  eventNumber: number;
  actor: string;
  action: string;
  details: unknown;
  previousHash: string | null;
  eventHash: string;
  createdAt: string;
};

export type PortableManifest = {
  packageVersion: string;
  schemaVersion: number;
  generatedAt: string;
  document: {
    id: string;
    referenceNo: string;
    originalName: string;
    mediaType: string;
    byteSize: number;
    sha256: string;
    documentType: string;
    documentProfileVersion: string | null;
    unit: string;
    status: string;
    uploadedBy: string;
    createdAt: string;
    updatedAt: string;
  };
  objects: ManifestObject[];
  relations: ManifestRelation[];
  ocrPages: ManifestOcrPage[];
  auditChain: ManifestAuditEvent[];
};

function requireSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`Taşınabilir paket ${label} değeri güvenli değil.`);
  }
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`Taşınabilir paket ${label} SHA-256 değeri geçersiz.`);
  }
}

function requireFiniteInteger(value: unknown, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`Taşınabilir paket ${label} sayısı geçersiz.`);
  }
}

function assertPackagePrefix(prefix: string) {
  if (!prefix || prefix.length > 512 || prefix.startsWith("/") || prefix.endsWith("/")
    || prefix.includes("\\") || prefix.split("/").some((part) => !SAFE_PREFIX_SEGMENT.test(part))) {
    throw new Error("Taşınabilir paket öneki güvenli değil.");
  }
}

/** Güvenilmeyen manifest değerleri anahtar veya SQL bağlamına ulaşmadan reddedilir. */
export function validatePortableManifest(manifest: PortableManifest): void {
  if (!manifest || typeof manifest !== "object" || manifest.packageVersion !== PORTABLE_PACKAGE_VERSION) {
    throw new Error("Taşınabilir paket sürümü desteklenmiyor.");
  }
  requireFiniteInteger(manifest.schemaVersion, "şema sürümü", 1);
  if (manifest.schemaVersion > ARCHIVE_SCHEMA_VERSION) {
    throw new Error("Taşınabilir paket daha yeni ve desteklenmeyen bir şema kullanıyor.");
  }
  if (!manifest.document || !Array.isArray(manifest.objects) || !Array.isArray(manifest.relations)
    || !Array.isArray(manifest.ocrPages) || !Array.isArray(manifest.auditChain)) {
    throw new Error("Taşınabilir paket yapısı eksik.");
  }
  requireSafeId(manifest.document.id, "belge kimliği");
  requireSha256(manifest.document.sha256, "belge");
  requireFiniteInteger(manifest.document.byteSize, "belge boyutu");
  if (manifest.objects.length < 1 || manifest.objects.length > 100_000) {
    throw new Error("Taşınabilir paket nesne sayısı geçersiz.");
  }
  const ids = new Set<string>();
  for (const object of manifest.objects) {
    requireSafeId(object.id, "nesne kimliği");
    if (ids.has(object.id)) throw new Error("Taşınabilir pakette mükerrer nesne kimliği var.");
    ids.add(object.id);
    if (!OBJECT_CLASSES.has(object.objectClass)) throw new Error("Taşınabilir paket nesne sınıfı geçersiz.");
    requireSha256(object.sha256, `nesne ${object.id}`);
    requireFiniteInteger(object.byteSize, `nesne ${object.id} boyutu`);
    if (object.derivedFromId !== null) requireSafeId(object.derivedFromId, "türev kaynak kimliği");
    if (object.derivedFromId === object.id) throw new Error("Taşınabilir paket nesnesi kendisinden türeyemez.");
  }
  const originals = manifest.objects.filter((object) => object.objectClass === "original");
  if (originals.length !== 1) throw new Error("Taşınabilir paket tam olarak bir asıl nesne içermelidir.");
  const original = originals[0];
  if (original.sha256 !== manifest.document.sha256 || original.byteSize !== manifest.document.byteSize
    || original.mediaType !== manifest.document.mediaType) {
    throw new Error("Taşınabilir paket belge kaydı asıl nesneyle uyuşmuyor.");
  }
  for (const object of manifest.objects) {
    if (object.derivedFromId !== null && !ids.has(object.derivedFromId)) {
      throw new Error("Taşınabilir paket türev kaynağı pakette bulunmuyor.");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(manifest.objects.map((object) => [object.id, object]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Taşınabilir paket türev grafiği döngülü.");
    if (visited.has(id)) return;
    visiting.add(id);
    const parent = byId.get(id)?.derivedFromId;
    if (parent) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  if (!manifest.auditChain.length) throw new Error("Taşınabilir paket denetim zinciri içermiyor.");
  const auditIds = new Set<string>();
  for (const event of manifest.auditChain) {
    requireSafeId(event.id, "denetim olayı kimliği");
    if (auditIds.has(event.id)) throw new Error("Taşınabilir pakette mükerrer denetim olayı var.");
    auditIds.add(event.id);
    requireSha256(event.eventHash, "denetim olayı");
    if (event.previousHash !== null) requireSha256(event.previousHash, "önceki denetim olayı");
  }
  const relationIds = new Set<string>();
  const entities = new Map<string, string>();
  for (const relation of manifest.relations) {
    requireSafeId(relation.id, "ilişki kimliği");
    if (relationIds.has(relation.id)) throw new Error("Taşınabilir pakette mükerrer ilişki kimliği var.");
    relationIds.add(relation.id);
    requireSafeId(relation.entity.id, "varlık kimliği");
    if (relation.verificationStatus !== "VERIFIED" || !relation.verifiedBy) {
      throw new Error("Taşınabilir paket yalnız doğrulanmış ilişkileri taşıyabilir.");
    }
    if (!relation.entity.attributes || relation.entity.attributes.kind !== relation.entity.entityType) {
      throw new Error("Taşınabilir paket varlık ayrıntısı türle uyuşmuyor.");
    }
    const definition = canonicalJson(relation.entity);
    const previous = entities.get(relation.entity.id);
    if (previous && previous !== definition) {
      throw new Error("Taşınabilir pakette aynı varlık farklı tanımlarla yer alıyor.");
    }
    entities.set(relation.entity.id, definition);
  }
  const pageNumbers = new Set<number>();
  for (const page of manifest.ocrPages) {
    requireFiniteInteger(page.pageNumber, "OCR sayfa numarası", 1);
    requireFiniteInteger(page.width, "OCR sayfa genişliği", 1);
    requireFiniteInteger(page.height, "OCR sayfa yüksekliği", 1);
    if (!Number.isFinite(page.averageConfidence) || page.averageConfidence < 0
      || page.averageConfidence > 1) throw new Error("OCR güven değeri geçersiz.");
    if (pageNumbers.has(page.pageNumber)) throw new Error("Taşınabilir pakette mükerrer OCR sayfası var.");
    pageNumbers.add(page.pageNumber);
  }
  if (new TextEncoder().encode(canonicalJson(manifest)).byteLength > MAX_PORTABLE_MANIFEST_BYTES) {
    throw new Error("Taşınabilir paket manifest boyut sınırını aşıyor.");
  }
}

/** Anahtarları özyinelemeli sıralayarak deterministik JSON üretir. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, sortKeys(entry)]));
  }
  return value;
}

export async function manifestDigest(manifest: PortableManifest): Promise<string> {
  return digestToHex(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(canonicalJson(manifest))));
}

/** Denetim zincirinin sıra ve önceki-özet bağını doğrular. */
export function verifyAuditLinkage(chain: ManifestAuditEvent[]): boolean {
  let previous: ManifestAuditEvent | null = null;
  for (const event of chain) {
    if (!SHA256_PATTERN.test(event.eventHash)) return false;
    if (event.eventNumber !== (previous?.eventNumber ?? 0) + 1) return false;
    if ((previous?.eventHash ?? null) !== event.previousHash) return false;
    previous = event;
  }
  return chain.length > 0;
}

function auditCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(auditCanonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, auditCanonicalize(item)]));
  }
  return value;
}

/** Bağın yanında her olay özetini kaynak `lib/audit.ts` algoritmasıyla yeniden hesaplar. */
export async function verifyAuditChain(documentId: string, chain: ManifestAuditEvent[]): Promise<boolean> {
  if (!verifyAuditLinkage(chain)) return false;
  for (const event of chain) {
    const payload = JSON.stringify({
      documentId,
      eventNumber: event.eventNumber,
      actor: event.actor,
      action: event.action,
      details: auditCanonicalize(event.details),
      previousHash: event.previousHash,
      createdAt: event.createdAt,
    });
    const actual = digestToHex(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(payload)));
    if (actual !== event.eventHash) return false;
  }
  return true;
}

function entityAttributes(row: Record<string, string | null>): ManifestEntityAttributes {
  if (row.entity_type === "PARCEL") {
    if (row.block_no === null || row.parcel_no === null || row.district_code === null
      || row.cadastral_neighborhood === null || row.parcel_status === null) {
      throw new Error("Doğrulanmış parsel ilişkisinin parsel ayrıntısı eksik.");
    }
    return { kind: "PARCEL", parcelExternalId: row.parcel_external_id,
      districtCode: row.district_code, cadastralNeighborhood: row.cadastral_neighborhood,
      blockNo: row.block_no, parcelNo: row.parcel_no, geometryVersion: row.geometry_version,
      parcelStatus: row.parcel_status };
  }
  if (row.entity_type === "ADDRESS") {
    if (row.neighborhood === null || row.street === null || row.door_no === null
      || row.unit_no === null || row.normalized_address === null) {
      throw new Error("Doğrulanmış adres ilişkisinin adres ayrıntısı eksik.");
    }
    return { kind: "ADDRESS", addressExternalId: row.address_external_id,
      nationalAddressId: row.national_address_id, neighborhood: row.neighborhood,
      street: row.street, doorNo: row.door_no, unitNo: row.unit_no,
      normalizedAddress: row.normalized_address, pointGeometry: row.point_geometry };
  }
  if (row.entity_type === "BUILDING") {
    if (row.building_label === null) throw new Error("Doğrulanmış bina ilişkisinin bina ayrıntısı eksik.");
    return { kind: "BUILDING", buildingExternalId: row.building_external_id,
      buildingLabel: row.building_label, parcelEntityId: row.parcel_entity_id,
      buildingGeometry: row.building_geometry, unitLabel: row.unit_label };
  }
  if (row.entity_type === "BUILDING_UNIT") return { kind: "BUILDING_UNIT" };
  throw new Error("Doğrulanmış ilişki desteklenmeyen bir varlık türü taşıyor.");
}
export async function buildPortableManifest(
  db: D1Database,
  documentId: string,
  options: { generatedAt?: string } = {},
): Promise<PortableManifest> {
  const document = await db.prepare(`SELECT id, reference_no, original_name, media_type,
      byte_size, sha256, document_type, document_profile_version, unit, status,
      uploaded_by, created_at, updated_at
    FROM archive_documents WHERE id = ?`).bind(documentId).first<Record<string, string | number | null>>();
  if (!document) throw new Error("Taşınabilir paket için belge bulunamadı.");

  const objects = await db.prepare(`SELECT id, object_class, media_type, byte_size, sha256,
      page_start, page_end, derived_from_id, generator, derivative_generation_id,
      retention_status, legal_hold_status, created_at
    FROM binary_objects
    WHERE document_id = ? AND retention_status <> 'DISPOSED'
    ORDER BY object_class, COALESCE(page_start, 0), id`)
    .bind(documentId).all<Record<string, string | number | null>>();
  if (!objects.results.some((row) => row.object_class === "original")) {
    throw new Error("Taşınabilir paket asıl nesne kaydı olmadan üretilemez.");
  }

  const relations = await db.prepare(`SELECT r.id, r.relation_type, r.relation_source,
      r.verification_status, r.verified_by, r.verified_at,
      e.id AS entity_id, e.entity_type, e.display_label, e.authority_source,
      e.external_id, e.entity_status,
      p.parcel_external_id, p.district_code, p.cadastral_neighborhood, p.block_no,
      p.parcel_no, p.geometry_version, p.parcel_status,
      a.address_external_id, a.national_address_id, a.neighborhood, a.street,
      a.door_no, a.unit_no, a.normalized_address, a.point_geometry,
      b.building_external_id, b.building_label, b.parcel_entity_id,
      b.building_geometry, b.unit_label
    FROM document_entity_relations r INNER JOIN entities e ON e.id = r.entity_id
      LEFT JOIN parcel_entities p ON p.entity_id = e.id
      LEFT JOIN address_entities a ON a.entity_id = e.id
      LEFT JOIN building_entities b ON b.entity_id = e.id
    WHERE r.document_id = ? AND r.verification_status = 'VERIFIED'
    ORDER BY r.id`).bind(documentId).all<Record<string, string | null>>();

  const pages = await db.prepare(`SELECT page_number, width, height, model,
      average_confidence, full_text, confirmed_text, confirmed_by, confirmed_at
    FROM ocr_pages WHERE document_id = ? ORDER BY page_number`)
    .bind(documentId).all<Record<string, string | number | null>>();

  const audit = await db.prepare(`SELECT id, event_number, actor, action, details_json, previous_hash,
      event_hash, created_at
    FROM audit_events WHERE document_id = ? ORDER BY event_number`)
    .bind(documentId).all<Record<string, string | number | null>>();

  const manifest: PortableManifest = {
    packageVersion: PORTABLE_PACKAGE_VERSION,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    document: {
      id: String(document.id),
      referenceNo: String(document.reference_no),
      originalName: String(document.original_name),
      mediaType: String(document.media_type),
      byteSize: Number(document.byte_size),
      sha256: String(document.sha256),
      documentType: String(document.document_type),
      documentProfileVersion: document.document_profile_version === null
        ? null : String(document.document_profile_version),
      unit: String(document.unit),
      status: String(document.status),
      uploadedBy: String(document.uploaded_by),
      createdAt: String(document.created_at),
      updatedAt: String(document.updated_at),
    },
    objects: objects.results.map((row) => ({
      id: String(row.id),
      objectClass: String(row.object_class),
      mediaType: String(row.media_type),
      byteSize: Number(row.byte_size),
      sha256: String(row.sha256),
      pageStart: row.page_start === null ? null : Number(row.page_start),
      pageEnd: row.page_end === null ? null : Number(row.page_end),
      derivedFromId: row.derived_from_id === null ? null : String(row.derived_from_id),
      generator: row.generator === null ? null : String(row.generator),
      derivativeGenerationId: row.derivative_generation_id === null
        ? null : String(row.derivative_generation_id),
      retentionStatus: String(row.retention_status),
      legalHoldStatus: String(row.legal_hold_status),
      createdAt: String(row.created_at),
    })),
    relations: relations.results.map((row) => ({
      id: String(row.id),
      relationType: String(row.relation_type),
      relationSource: String(row.relation_source),
      verificationStatus: String(row.verification_status),
      verifiedBy: row.verified_by === null ? null : String(row.verified_by),
      verifiedAt: row.verified_at === null ? null : String(row.verified_at),
      entity: {
        id: String(row.entity_id),
        entityType: String(row.entity_type),
        displayLabel: String(row.display_label),
        authoritySource: String(row.authority_source),
        externalId: row.external_id === null ? null : String(row.external_id),
        entityStatus: String(row.entity_status),
        attributes: entityAttributes(row),
      },
    })),
    ocrPages: pages.results.map((row) => ({
      pageNumber: Number(row.page_number),
      width: Number(row.width),
      height: Number(row.height),
      model: String(row.model),
      averageConfidence: Number(row.average_confidence),
      fullText: String(row.full_text),
      confirmedText: row.confirmed_text === null ? null : String(row.confirmed_text),
      confirmedBy: row.confirmed_by === null ? null : String(row.confirmed_by),
      confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
    })),
    auditChain: audit.results.map((row) => ({
      id: String(row.id),
      eventNumber: Number(row.event_number),
      actor: String(row.actor),
      action: String(row.action),
      details: JSON.parse(String(row.details_json)),
      previousHash: row.previous_hash === null ? null : String(row.previous_hash),
      eventHash: String(row.event_hash),
      createdAt: String(row.created_at),
    })),
  };
  validatePortableManifest(manifest);
  return manifest;
}

function packageObjectKey(prefix: string, objectId: string) {
  return `${prefix}/objects/${objectId}`;
}

function packageManifestKey(prefix: string) {
  return `${prefix}/manifest.json`;
}

function topologicallySortedObjects(manifest: PortableManifest) {
  const byId = new Map(manifest.objects.map((object) => [object.id, object]));
  const result: ManifestObject[] = [];
  const added = new Set<string>();
  const add = (object: ManifestObject) => {
    if (added.has(object.id)) return;
    if (object.derivedFromId) add(byId.get(object.derivedFromId)!);
    added.add(object.id);
    result.push(object);
  };
  for (const object of manifest.objects) add(object);
  return result;
}

export type ExportDependencies = {
  db: D1Database;
  /** Kaynak nesneleri kayıtlı ad alanlarından okuyan çözücü. */
  readerForNamespace: (namespace: string) => ObjectReader;
  /** Paket hedefi koşullu ilk yazma yapar; mevcut paketin üzerine yazılamaz. */
  target: ImmutableVaultWriter;
  hasher: StreamingHasher;
};

/**
 * Nesneler koşullu yazılır, kaynak SHA uygulama tarafından akışla yeniden
 * hesaplanır ve manifest en son commit işareti olarak yazılır. Yarım kalan bir
 * aktarım manifest taşımadığı için geçerli paket sayılamaz ve üzerine yazılamaz.
 */
export async function exportPortablePackage(
  dependencies: ExportDependencies,
  documentId: string,
  packagePrefix: string,
  options: { generatedAt?: string } = {},
) {
  assertPackagePrefix(packagePrefix);
  const manifest = await buildPortableManifest(dependencies.db, documentId, options);
  validatePortableManifest(manifest);
  if (!await verifyAuditChain(manifest.document.id, manifest.auditChain)) {
    throw new Error("Kaynak denetim zinciri kriptografik doğrulamadan geçmedi.");
  }
  const digest = await manifestDigest(manifest);
  const namespaces = await dependencies.db.prepare(`SELECT id, object_key, bucket_or_namespace
    FROM binary_objects WHERE document_id = ? AND retention_status <> 'DISPOSED'`)
    .bind(documentId).all<{ id: string; object_key: string; bucket_or_namespace: string }>();
  const locationOf = new Map(namespaces.results.map((row) => [row.id, row]));

  for (const object of manifest.objects) {
    const location = locationOf.get(object.id);
    if (!location) throw new Error("Paket nesnesinin depolama kaydı bulunamadı.");
    const source = await dependencies.readerForNamespace(location.bucket_or_namespace)
      .get(location.object_key);
    if (!source || source.range !== null || source.size !== object.byteSize
      || source.bodySize !== object.byteSize || source.contentType !== object.mediaType) {
      throw new Error(`Paket kaynağı yetkili kayıtla uyuşmuyor: ${object.objectClass}/${object.id}`);
    }
    const [hashBody, writeBody] = source.body.tee();
    const [actual, stored] = await Promise.all([
      dependencies.hasher.sha256(hashBody),
      dependencies.target.putIfAbsent(packageObjectKey(packagePrefix, object.id), writeBody, {
        contentType: object.mediaType,
        contentSha256Hex: object.sha256,
        customMetadata: {
          sha256: object.sha256,
          objectClass: object.objectClass,
          packageDigest: digest,
        },
      }),
    ]);
    if (actual.byteSize !== object.byteSize || actual.sha256Hex !== object.sha256
      || stored.size !== object.byteSize || stored.contentType !== object.mediaType) {
      throw new Error(`Paket nesnesi yazma doğrulamasından geçmedi: ${object.id}`);
    }
  }

  // Uzun nesne kopyası sırasında veritabanı bağlamı değiştiyse eski/yeni
  // karışımı bir manifest commit edilmez.
  const sourceAfterCopy = await buildPortableManifest(dependencies.db, documentId, {
    generatedAt: manifest.generatedAt,
  });
  if (canonicalJson(sourceAfterCopy) !== canonicalJson(manifest)) {
    throw new Error("Paket kaynağı aktarım sırasında değişti; manifest commit edilmedi.");
  }

  const manifestText = canonicalJson(manifest);
  const storedManifest = await dependencies.target.putIfAbsent(
    packageManifestKey(packagePrefix), manifestText, {
      contentType: "application/json",
      contentSha256Hex: digest,
      customMetadata: { manifestDigest: digest, packageVersion: PORTABLE_PACKAGE_VERSION },
    });
  if (storedManifest.size !== new TextEncoder().encode(manifestText).byteLength) {
    throw new Error("Paket manifesti yazma doğrulamasından geçmedi.");
  }
  return { manifest, manifestDigest: digest, objectCount: manifest.objects.length };
}

export type VerifyDependencies = {
  /** Paket hedefini okuyan adaptör; kaynak sağlayıcıdan bağımsızdır. */
  reader: ObjectReader;
  hasher: StreamingHasher;
};

export type VerifyPortableOptions = {
  /** Yedek kataloğu/denetim kaydından gelen, paket dışındaki güven kökü. */
  expectedManifestDigest: string;
};

/**
 * Paket, kendi dışındaki güvenilir manifest özeti ve tam nesne SHA'larıyla
 * doğrulanır. Manifest+nesnelerin birlikte yeniden üretilmesi bu güven kökü
 * olmadan doğrulama sayılmaz.
 */
export async function verifyPortablePackage(
  dependencies: VerifyDependencies,
  manifest: PortableManifest,
  packagePrefix: string,
  options: VerifyPortableOptions,
) {
  assertPackagePrefix(packagePrefix);
  requireSha256(options.expectedManifestDigest, "beklenen manifest");
  const failures: string[] = [];
  try {
    validatePortableManifest(manifest);
  } catch {
    failures.push("MANIFEST_SCHEMA");
    return { verified: false, failures };
  }

  const calculatedManifestDigest = await manifestDigest(manifest);
  if (calculatedManifestDigest !== options.expectedManifestDigest) {
    failures.push("MANIFEST_TRUST_DIGEST_MISMATCH");
  }
  if (!await verifyAuditChain(manifest.document.id, manifest.auditChain)) {
    failures.push("AUDIT_CHAIN_HASH");
  }

  const stored = await dependencies.reader.get(packageManifestKey(packagePrefix));
  if (!stored || stored.range !== null) {
    failures.push("MANIFEST_MISSING");
  } else if (stored.size > MAX_PORTABLE_MANIFEST_BYTES || stored.bodySize !== stored.size
    || stored.contentType !== "application/json") {
    failures.push("MANIFEST_INVALID");
  } else {
    const digest = await dependencies.hasher.sha256(stored.body);
    if (digest.byteSize !== stored.size || digest.sha256Hex !== options.expectedManifestDigest) {
      failures.push("MANIFEST_DIGEST_MISMATCH");
    }
  }

  for (const object of manifest.objects) {
    const entry = await dependencies.reader.get(packageObjectKey(packagePrefix, object.id));
    if (!entry || entry.range !== null) {
      failures.push(`OBJECT_MISSING:${object.id}`);
      continue;
    }
    if (entry.size !== object.byteSize || entry.bodySize !== object.byteSize
      || entry.contentType !== object.mediaType) {
      failures.push(`OBJECT_METADATA_MISMATCH:${object.id}`);
      continue;
    }
    const digest = await dependencies.hasher.sha256(entry.body);
    if (digest.byteSize !== object.byteSize || digest.sha256Hex !== object.sha256) {
      failures.push(`OBJECT_SHA_MISMATCH:${object.id}`);
    }
  }
  return { verified: failures.length === 0, failures };
}

export type RestoreStorageTarget = {
  namespace: string;
  /** Ayrı kova/servis kimliği/IAM sınırını tanımlayan kapalı yerleşim kimliği. */
  securityDomain: string;
  storage: Pick<StagingStorage, "put" | "get" | "head" | "delete">;
};

export type RestoreDependencies = {
  /** Bağımsız geri yükleme veritabanı; üretim şeması uygulanmış olmalıdır. */
  db: D1Database;
  packageReader: ObjectReader;
  /** Asıl ve türevler ayrı depolama yetki alanlarına yönlendirilir. */
  restoreTargetForObjectClass: (objectClass: string) => RestoreStorageTarget;
  hasher: StreamingHasher;
};

export type RestorePortableOptions = VerifyPortableOptions & {
  restoreRunId?: string;
  restoredAt?: string;
};

function entityStatements(db: D1Database, relation: ManifestRelation) {
  const attributes = relation.entity.attributes;
  if (attributes.kind === "PARCEL") {
    return [db.prepare(`INSERT INTO parcel_entities
      (entity_id, parcel_external_id, district_code, cadastral_neighborhood,
       block_no, parcel_no, geometry_version, parcel_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(relation.entity.id,
      attributes.parcelExternalId, attributes.districtCode, attributes.cadastralNeighborhood,
      attributes.blockNo, attributes.parcelNo, attributes.geometryVersion, attributes.parcelStatus)];
  }
  if (attributes.kind === "ADDRESS") {
    return [db.prepare(`INSERT INTO address_entities
      (entity_id, address_external_id, national_address_id, neighborhood, street,
       door_no, unit_no, normalized_address, point_geometry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(relation.entity.id,
      attributes.addressExternalId, attributes.nationalAddressId, attributes.neighborhood,
      attributes.street, attributes.doorNo, attributes.unitNo,
      attributes.normalizedAddress, attributes.pointGeometry)];
  }
  if (attributes.kind === "BUILDING") {
    return [db.prepare(`INSERT INTO building_entities
      (entity_id, building_external_id, building_label, parcel_entity_id,
       building_geometry, unit_label) VALUES (?, ?, ?, ?, ?, ?)`).bind(relation.entity.id,
      attributes.buildingExternalId, attributes.buildingLabel, attributes.parcelEntityId,
      attributes.buildingGeometry, attributes.unitLabel)];
  }
  return [];
}

async function restoredAuditReceipt(
  db: D1Database,
  manifest: PortableManifest,
  manifestDigestValue: string,
  restoreRunId: string,
  restoredAt: string,
) {
  const previous = manifest.auditChain.at(-1)!;
  const eventNumber = previous.eventNumber + 1;
  const details = auditCanonicalize({
    manifestDigest: manifestDigestValue,
    packageVersion: manifest.packageVersion,
    restoreRunId,
    sourceAuditHead: previous.eventHash,
  });
  const payload = JSON.stringify({
    documentId: manifest.document.id,
    eventNumber,
    actor: "system:portable-restore",
    action: "document.portable-restored",
    details,
    previousHash: previous.eventHash,
    createdAt: restoredAt,
  });
  const eventHash = digestToHex(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(payload)));
  return db.prepare(`INSERT INTO audit_events
    (id, document_id, event_number, actor, action, details_json, previous_hash, event_hash, created_at)
    VALUES (?, ?, ?, 'system:portable-restore', 'document.portable-restored', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), manifest.document.id, eventNumber, JSON.stringify(details),
      previous.eventHash, eventHash, restoredAt);
}

/**
 * Doğrulanmış paketi benzersiz bir çalışma önekine açar. Depo veya veritabanı
 * adımlarından biri başarısızsa yazılan çalışma nesneleri geri alınır. Kaynak
 * denetim zinciri aynen korunur ve yerel geri yükleme alındısı zincire eklenir.
 */
export async function restorePortablePackage(
  dependencies: RestoreDependencies,
  manifest: PortableManifest,
  packagePrefix: string,
  options: RestorePortableOptions,
) {
  assertPackagePrefix(packagePrefix);
  validatePortableManifest(manifest);
  const verification = await verifyPortablePackage(
    { reader: dependencies.packageReader, hasher: dependencies.hasher },
    manifest, packagePrefix, options);
  if (!verification.verified) {
    throw new Error(`Paket doğrulanamadı: ${verification.failures.join(", ")}`);
  }

  const restoreRunId = options.restoreRunId ?? crypto.randomUUID();
  requireSafeId(restoreRunId, "geri yükleme koşusu kimliği");
  const restoredAt = options.restoredAt ?? new Date().toISOString();
  const originalObject = manifest.objects.find((object) => object.objectClass === "original")!;
  const existingDocument = await dependencies.db.prepare(
    "SELECT id FROM archive_documents WHERE id = ?").bind(manifest.document.id).first();
  if (existingDocument) throw new Error("Geri yükleme hedefinde belge kimliği zaten mevcut.");

  const restoredTargets = new Map<string, RestoreStorageTarget & { key: string }>();
  for (const object of manifest.objects) {
    const target = dependencies.restoreTargetForObjectClass(object.objectClass);
    if (!target.namespace || target.namespace.length > 128
      || !SAFE_ID_PATTERN.test(target.securityDomain)) {
      throw new Error("Geri yükleme depolama yetki alanı geçersiz.");
    }
    const key = `restores/${restoreRunId}/${manifest.document.id}/${object.objectClass}/${object.id}`;
    if (await target.storage.head(key)) {
      throw new Error("Geri yükleme koşusu öneki daha önce kullanılmış.");
    }
    restoredTargets.set(object.id, { ...target, key });
  }
  const originalTarget = restoredTargets.get(originalObject.id)!;
  if (manifest.objects.some((object) => object.objectClass !== "original"
    && (restoredTargets.get(object.id)!.namespace === originalTarget.namespace
      || restoredTargets.get(object.id)!.securityDomain === originalTarget.securityDomain))) {
    throw new Error("Geri yüklemede asıl ve türev aynı depolama yetki alanına bağlanamaz.");
  }

  const writtenTargets: Array<RestoreStorageTarget & { key: string }> = [];
  try {
    for (const object of topologicallySortedObjects(manifest)) {
      const source = await dependencies.packageReader.get(packageObjectKey(packagePrefix, object.id));
      if (!source || source.range !== null) throw new Error("Paket nesnesi geri okunamadı.");
      const target = restoredTargets.get(object.id)!;
      writtenTargets.push(target);
      const stored = await target.storage.put(target.key, source.body, {
        contentType: object.mediaType,
        contentSha256Hex: object.sha256,
        customMetadata: {
          sha256: object.sha256,
          objectClass: object.objectClass,
          manifestDigest: options.expectedManifestDigest,
          restoreRunId,
        },
      });
      const readBack = await target.storage.get(target.key);
      if (!readBack || readBack.range !== null || stored.size !== object.byteSize
        || readBack.size !== object.byteSize || readBack.bodySize !== object.byteSize
        || readBack.contentType !== object.mediaType) {
        throw new Error(`Geri yüklenen nesne metadata doğrulamasından geçmedi: ${object.id}`);
      }
      const digest = await dependencies.hasher.sha256(readBack.body);
      if (digest.byteSize !== object.byteSize || digest.sha256Hex !== object.sha256) {
        throw new Error(`Geri yüklenen nesne SHA doğrulamasından geçmedi: ${object.id}`);
      }
    }

    const uniqueEntities = new Map<string, ManifestRelation>();
    for (const relation of manifest.relations) {
      const previous = uniqueEntities.get(relation.entity.id);
      if (previous && canonicalJson(previous.entity) !== canonicalJson(relation.entity)) {
        throw new Error("Aynı varlık kimliği farklı tanımlarla paketlenmiş.");
      }
      uniqueEntities.set(relation.entity.id, relation);
    }
    const orderedObjects = topologicallySortedObjects(manifest);
    const entityRows = [...uniqueEntities.values()];
    const statements: D1PreparedStatement[] = [
      dependencies.db.prepare(`INSERT INTO archive_documents
        (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
         document_type, document_profile_version, unit, status, uploaded_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(manifest.document.id, manifest.document.referenceNo, manifest.document.originalName,
          restoredTargets.get(originalObject.id)?.key, manifest.document.mediaType, manifest.document.byteSize,
          manifest.document.sha256, manifest.document.documentType,
          manifest.document.documentProfileVersion, manifest.document.unit,
          manifest.document.status, manifest.document.uploadedBy,
          manifest.document.createdAt, manifest.document.updatedAt),
      ...orderedObjects.map((object) => dependencies.db.prepare(`INSERT INTO binary_objects
        (id, document_id, object_class, object_key, storage_provider, bucket_or_namespace,
         media_type, byte_size, sha256, derived_from_id, generator, page_start, page_end,
         derivative_generation_id, retention_status, legal_hold_status, created_at)
        VALUES (?, ?, ?, ?, 'restore', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(object.id, manifest.document.id, object.objectClass, restoredTargets.get(object.id)?.key,
          restoredTargets.get(object.id)?.namespace, object.mediaType, object.byteSize,
          object.sha256, object.derivedFromId,
          object.generator, object.pageStart, object.pageEnd, object.derivativeGenerationId,
          object.retentionStatus, object.legalHoldStatus, object.createdAt)),
      ...entityRows.map((relation) => dependencies.db.prepare(`INSERT INTO entities
        (id, entity_type, display_label, authority_source, external_id, entity_status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 'portable-restore')`)
        .bind(relation.entity.id, relation.entity.entityType, relation.entity.displayLabel,
          relation.entity.authoritySource, relation.entity.externalId, relation.entity.entityStatus)),
      ...entityRows.flatMap((relation) => entityStatements(dependencies.db, relation)),
      ...manifest.relations.map((relation) => dependencies.db.prepare(`INSERT INTO document_entity_relations
        (id, document_id, entity_id, relation_type, relation_source, verification_status,
         verified_by, verified_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'portable-restore')`)
        .bind(relation.id, manifest.document.id, relation.entity.id, relation.relationType,
          relation.relationSource, relation.verificationStatus, relation.verifiedBy, relation.verifiedAt)),
      ...manifest.ocrPages.map((page) => dependencies.db.prepare(`INSERT INTO ocr_pages
        (id, document_id, page_number, width, height, raw_text, full_text, search_text,
         confirmed_text, confirmed_by, confirmed_at, words_json, average_confidence, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
        .bind(crypto.randomUUID(), manifest.document.id, page.pageNumber, page.width, page.height,
          page.fullText, page.fullText, normalizeSearch(page.fullText), page.confirmedText,
          page.confirmedBy, page.confirmedAt, page.averageConfidence, page.model)),
      ...manifest.auditChain.map((event) => dependencies.db.prepare(`INSERT INTO audit_events
        (id, document_id, event_number, actor, action, details_json, previous_hash, event_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(event.id, manifest.document.id, event.eventNumber, event.actor, event.action,
          JSON.stringify(auditCanonicalize(event.details)), event.previousHash,
          event.eventHash, event.createdAt)),
      await restoredAuditReceipt(dependencies.db, manifest, options.expectedManifestDigest,
        restoreRunId, restoredAt),
    ];
    await dependencies.db.batch(statements);
  } catch (error) {
    const cleanup = await Promise.allSettled(writtenTargets.reverse()
      .map((target) => target.storage.delete(target.key)));
    const cleanupFailures = cleanup.filter((result) => result.status === "rejected").length;
    if (cleanupFailures) {
      throw new Error(`Geri yükleme başarısız oldu ve ${cleanupFailures} çalışma nesnesi temizlenemedi.`,
        { cause: error });
    }
    throw error;
  }

  return {
    restored: true,
    documentId: manifest.document.id,
    objectCount: manifest.objects.length,
    relationCount: manifest.relations.length,
    ocrPageCount: manifest.ocrPages.length,
    auditEventCount: manifest.auditChain.length + 1,
    manifestDigest: options.expectedManifestDigest,
    restoreRunId,
    auditChainVerified: true,
  };
}