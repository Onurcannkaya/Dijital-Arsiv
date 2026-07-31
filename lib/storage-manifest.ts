/**
 * F1.10 / ADR-017 — Sağlayıcıdan bağımsız taşınabilir belge paketi.
 *
 * Paket; mantıksal kimlikler, nesne sınıfı/boyut/medya türü/SHA-256 manifesti,
 * belge üst verisi ve profil sürümü, doğrulanmış varlık ilişkileri, OCR metin
 * bağlamı ve denetim zincirinin doğrulama bölümünü taşır. Sağlayıcı anahtarı,
 * ETag ve sürüm kimliği pakete BİLİNÇLİ olarak girmez: taşınabilir bütünlük
 * kanıtı yalnız içerik SHA-256'sıdır (ADR-017). Manifest kanonik JSON'dur;
 * aynı veri her çalıştırmada bayt-bayt aynı manifesti üretir.
 */

import { digestToHex, type StreamingHasher } from "./content-hasher.ts";
import { ARCHIVE_SCHEMA_VERSION } from "./archive-schema.ts";
import type { ObjectReader, StagingStorage } from "./object-storage.ts";
import { normalizeSearch } from "./text-search.ts";

export const PORTABLE_PACKAGE_VERSION = "portable-package-v1";

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
};

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
  eventNumber: number;
  actor: string;
  action: string;
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
    createdAt: string;
    updatedAt: string;
  };
  objects: ManifestObject[];
  relations: ManifestRelation[];
  ocrPages: ManifestOcrPage[];
  auditChain: ManifestAuditEvent[];
};

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

/**
 * Denetim zinciri bölümünün bağ bütünlüğünü doğrular: numaralar 1'den ardışık,
 * her olayın `previousHash` değeri bir önceki olayın özetine eşittir. Olay
 * içeriğinin yeniden hesaplanması kaynak sistemin işidir; paket taşınan bölümün
 * KOPMAMIŞ olduğunu kanıtlar.
 */
export function verifyAuditLinkage(chain: ManifestAuditEvent[]): boolean {
  let previous: ManifestAuditEvent | null = null;
  for (const event of chain) {
    if (!/^[a-f0-9]{64}$/.test(event.eventHash)) return false;
    if (event.eventNumber !== (previous?.eventNumber ?? 0) + 1) return false;
    if ((previous?.eventHash ?? null) !== event.previousHash) return false;
    previous = event;
  }
  return true;
}

export async function buildPortableManifest(
  db: D1Database,
  documentId: string,
  options: { generatedAt?: string } = {},
): Promise<PortableManifest> {
  const document = await db.prepare(`SELECT id, reference_no, original_name, media_type,
      byte_size, sha256, document_type, document_profile_version, unit, status,
      created_at, updated_at
    FROM archive_documents WHERE id = ?`).bind(documentId).first<Record<string, string | number | null>>();
  if (!document) throw new Error("Taşınabilir paket için belge bulunamadı.");

  const objects = await db.prepare(`SELECT id, object_class, media_type, byte_size, sha256,
      page_start, page_end, derived_from_id, generator, derivative_generation_id,
      retention_status, legal_hold_status
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
      e.external_id, e.entity_status
    FROM document_entity_relations r INNER JOIN entities e ON e.id = r.entity_id
    WHERE r.document_id = ? AND r.verification_status = 'VERIFIED'
    ORDER BY r.id`).bind(documentId).all<Record<string, string | null>>();

  const pages = await db.prepare(`SELECT page_number, width, height, model,
      average_confidence, full_text, confirmed_text, confirmed_by, confirmed_at
    FROM ocr_pages WHERE document_id = ? ORDER BY page_number`)
    .bind(documentId).all<Record<string, string | number | null>>();

  const audit = await db.prepare(`SELECT event_number, actor, action, previous_hash,
      event_hash, created_at
    FROM audit_events WHERE document_id = ? ORDER BY event_number`)
    .bind(documentId).all<Record<string, string | number | null>>();

  return {
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
      eventNumber: Number(row.event_number),
      actor: String(row.actor),
      action: String(row.action),
      previousHash: row.previous_hash === null ? null : String(row.previous_hash),
      eventHash: String(row.event_hash),
      createdAt: String(row.created_at),
    })),
  };
}

function packageObjectKey(prefix: string, objectId: string) {
  return `${prefix}/objects/${objectId}`;
}

function packageManifestKey(prefix: string) {
  return `${prefix}/manifest.json`;
}

export type ExportDependencies = {
  db: D1Database;
  /** Kaynak nesneleri kayıtlı ad alanlarından okuyan çözücü. */
  readerForNamespace: (namespace: string) => ObjectReader;
  /** Paket hedefi: herhangi bir S3 uyumlu adaptör. */
  target: Pick<StagingStorage, "put">;
  hasher: StreamingHasher;
};

/**
 * Belgeyi taşınabilir pakete aktarır. Her nesne kaynağından akışla okunur ve
 * hedefe yetkili SHA beyanıyla yazılır: hedef adaptör içerik özetini bağımsız
 * doğrular. Sağlayıcı ETag/sürüm kimliği hiçbir aşamada kanıt sayılmaz.
 */
export async function exportPortablePackage(
  dependencies: ExportDependencies,
  documentId: string,
  packagePrefix: string,
  options: { generatedAt?: string } = {},
) {
  const manifest = await buildPortableManifest(dependencies.db, documentId, options);
  const namespaces = await dependencies.db.prepare(`SELECT id, object_key, bucket_or_namespace
    FROM binary_objects WHERE document_id = ? AND retention_status <> 'DISPOSED'`)
    .bind(documentId).all<{ id: string; object_key: string; bucket_or_namespace: string }>();
  const locationOf = new Map(namespaces.results.map((row) => [row.id, row]));

  for (const object of manifest.objects) {
    const location = locationOf.get(object.id);
    if (!location) throw new Error("Paket nesnesinin depolama kaydı bulunamadı.");
    const source = await dependencies.readerForNamespace(location.bucket_or_namespace)
      .get(location.object_key);
    if (!source || source.range !== null) {
      throw new Error(`Paket kaynağı tam okunamadı: ${object.objectClass}/${object.id}`);
    }
    // Hedef, beyan edilen SHA'yı bağımsız doğrular; akış tek geçişte kopyalanır.
    await dependencies.target.put(packageObjectKey(packagePrefix, object.id), source.body, {
      contentType: object.mediaType,
      contentSha256Hex: object.sha256,
      customMetadata: { sha256: object.sha256, objectClass: object.objectClass },
    });
  }

  const digest = await manifestDigest(manifest);
  await dependencies.target.put(packageManifestKey(packagePrefix), canonicalJson(manifest), {
    contentType: "application/json",
    contentSha256Hex: digest,
  });
  return { manifest, manifestDigest: digest, objectCount: manifest.objects.length };
}

export type VerifyDependencies = {
  /** Paket hedefini okuyan adaptör; kaynak sağlayıcıdan bağımsızdır. */
  reader: ObjectReader;
  hasher: StreamingHasher;
};

/**
 * Paketi hedef adaptör üzerinden doğrular: manifest özeti ve her nesnenin tam
 * akış SHA-256/boyutu eşleşmelidir. Sağlayıcının ETag veya sürüm kimliği
 * karşılaştırmaya girmez (ADR-017 kabul ölçütü).
 */
export async function verifyPortablePackage(
  dependencies: VerifyDependencies,
  manifest: PortableManifest,
  packagePrefix: string,
) {
  const failures: string[] = [];
  if (!verifyAuditLinkage(manifest.auditChain)) failures.push("AUDIT_CHAIN_LINKAGE");

  const stored = await dependencies.reader.get(packageManifestKey(packagePrefix));
  if (!stored || stored.range !== null) {
    failures.push("MANIFEST_MISSING");
  } else {
    const digest = await dependencies.hasher.sha256(stored.body);
    if (digest.sha256Hex !== await manifestDigest(manifest)) failures.push("MANIFEST_DIGEST_MISMATCH");
  }

  for (const object of manifest.objects) {
    const entry = await dependencies.reader.get(packageObjectKey(packagePrefix, object.id));
    if (!entry || entry.range !== null) {
      failures.push(`OBJECT_MISSING:${object.id}`);
      continue;
    }
    const digest = await dependencies.hasher.sha256(entry.body);
    if (digest.byteSize !== object.byteSize || digest.sha256Hex !== object.sha256) {
      failures.push(`OBJECT_SHA_MISMATCH:${object.id}`);
    }
  }
  return { verified: failures.length === 0, failures };
}

export type RestoreDependencies = {
  /** Bağımsız geri yükleme veritabanı; üretim şeması uygulanmış olmalıdır. */
  db: D1Database;
  /** Paket hedefini okuyan adaptör. */
  packageReader: ObjectReader;
  /** Geri yükleme alanının yazıcısı. */
  restoreStorage: Pick<StagingStorage, "put">;
  hasher: StreamingHasher;
  restoreNamespace?: string;
};

/**
 * Paketi bağımsız geri yükleme alanına açar: nesneler SHA doğrulamasıyla
 * kopyalanır; belge, nesne kayıtları, varlıklar, ilişkiler ve OCR bağlamı
 * yazılır. Denetim zinciri yerel `audit_events` zincirine EKLENMEZ (o zincir
 * yerel olaylara aittir); bağ bütünlüğü doğrulanır ve paket kanıtı olarak
 * taşınır. Üretim verisinin üzerine yazılmaz: hedef veritabanı ayrıdır.
 */
export async function restorePortablePackage(
  dependencies: RestoreDependencies,
  manifest: PortableManifest,
  packagePrefix: string,
) {
  const verification = await verifyPortablePackage(
    { reader: dependencies.packageReader, hasher: dependencies.hasher }, manifest, packagePrefix);
  if (!verification.verified) {
    throw new Error(`Paket doğrulanamadı: ${verification.failures.join(", ")}`);
  }
  const namespace = dependencies.restoreNamespace ?? "RESTORE_FILES";
  const originalObject = manifest.objects.find((object) => object.objectClass === "original");
  if (!originalObject) throw new Error("Pakette asıl nesne yok.");

  const restoredKeys = new Map<string, string>();
  for (const object of manifest.objects) {
    const source = await dependencies.packageReader.get(packageObjectKey(packagePrefix, object.id));
    if (!source || source.range !== null) throw new Error("Paket nesnesi geri okunamadı.");
    const key = object.objectClass === "original"
      ? `originals/${manifest.document.id}/${object.id}`
      : `derivatives/${manifest.document.id}/${object.objectClass}/${object.id}`;
    await dependencies.restoreStorage.put(key, source.body, {
      contentType: object.mediaType,
      contentSha256Hex: object.sha256,
      customMetadata: { sha256: object.sha256, objectClass: object.objectClass },
    });
    restoredKeys.set(object.id, key);
  }

  const statements: D1PreparedStatement[] = [
    dependencies.db.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
       document_type, document_profile_version, unit, status, uploaded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'portable-restore', ?, ?)`)
      .bind(manifest.document.id, manifest.document.referenceNo, manifest.document.originalName,
        restoredKeys.get(originalObject.id), manifest.document.mediaType, manifest.document.byteSize,
        manifest.document.sha256, manifest.document.documentType,
        manifest.document.documentProfileVersion, manifest.document.unit,
        manifest.document.status, manifest.document.createdAt, manifest.document.updatedAt),
    // `derived_from_id` asıl kayda bağlanır: önce asıllar, sonra türevler yazılır.
    ...[...manifest.objects].sort((left, right) =>
      Number(right.objectClass === "original") - Number(left.objectClass === "original"))
      .map((object) => dependencies.db.prepare(`INSERT INTO binary_objects
        (id, document_id, object_class, object_key, storage_provider, bucket_or_namespace,
         media_type, byte_size, sha256, derived_from_id, generator, page_start, page_end,
         derivative_generation_id, retention_status, legal_hold_status, created_at)
      VALUES (?, ?, ?, ?, 'restore', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(object.id, manifest.document.id, object.objectClass, restoredKeys.get(object.id),
        namespace, object.mediaType, object.byteSize, object.sha256, object.derivedFromId,
        object.generator, object.pageStart, object.pageEnd, object.derivativeGenerationId,
        object.retentionStatus, object.legalHoldStatus)),
    ...manifest.relations.map((relation) => dependencies.db.prepare(`INSERT OR IGNORE INTO entities
        (id, entity_type, display_label, authority_source, external_id, entity_status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'portable-restore')`)
      .bind(relation.entity.id, relation.entity.entityType, relation.entity.displayLabel,
        relation.entity.authoritySource, relation.entity.externalId, relation.entity.entityStatus)),
    ...manifest.relations.map((relation) => dependencies.db.prepare(`INSERT INTO document_entity_relations
        (id, document_id, entity_id, relation_type, relation_source, verification_status,
         verified_by, verified_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'portable-restore')`)
      .bind(relation.id, manifest.document.id, relation.entity.id, relation.relationType,
        relation.relationSource, relation.verificationStatus, relation.verifiedBy, relation.verifiedAt)),
    // OCR kelime koordinatları pakete alınmaz (pilot kapsamı); metin bağlamı korunur.
    ...manifest.ocrPages.map((page) => dependencies.db.prepare(`INSERT INTO ocr_pages
        (id, document_id, page_number, width, height, raw_text, full_text, search_text,
         confirmed_text, confirmed_by, confirmed_at, words_json, average_confidence, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
      .bind(crypto.randomUUID(), manifest.document.id, page.pageNumber, page.width, page.height,
        page.fullText, page.fullText, normalizeSearch(page.fullText), page.confirmedText,
        page.confirmedBy, page.confirmedAt, page.averageConfidence, page.model)),
  ];
  await dependencies.db.batch(statements);
  return {
    restored: true,
    documentId: manifest.document.id,
    objectCount: manifest.objects.length,
    relationCount: manifest.relations.length,
    ocrPageCount: manifest.ocrPages.length,
    auditChainVerified: verifyAuditLinkage(manifest.auditChain),
  };
}
