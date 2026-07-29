/**
 * Ortak varlık ve belge-varlık ilişki servisi.
 *
 * Kaynak sözleşmeler: VERI_SOZLUGU.md §9–§11, ANA_SISTEM_TASARIM_BELGESI.md §7.3–§7.5,
 * ADR-009 (çoktan çoğa ilişki modeli), ADR-010 (yetkili CBS kimliği), ADR-011 (parsel soyu).
 *
 * Temel kural: bir varlık, yetkili dış kimlik (CBS) yoksa `PROVISIONAL` durumda
 * oluşturulur ve ilişkileri doğrulanmış hukuki bağ sayılmaz. Kesin parsel kimliği
 * ilçe + kadastro mahallesi + CBS kimliği ile verilir.
 */

export const UNKNOWN_IDENTITY = "UNKNOWN";

export type EntityType = "PARCEL" | "ADDRESS" | "BUILDING" | "BUILDING_UNIT";
export type RelationType =
  | "SUBJECT" | "AFFECTS" | "ATTACHMENT_REFERENCE" | "NEIGHBOR"
  | "PARTY" | "HISTORICAL_LINK" | "SPATIAL_INTERSECTION" | "TEXT_MENTION";
export type RelationSource = "GIS" | "HUMAN" | "OCR" | "INTEGRATION" | "SPATIAL";
export type RelationVerification = "SUGGESTED" | "VERIFIED" | "REJECTED";

export const relationTypes: RelationType[] = [
  "SUBJECT", "AFFECTS", "ATTACHMENT_REFERENCE", "NEIGHBOR",
  "PARTY", "HISTORICAL_LINK", "SPATIAL_INTERSECTION", "TEXT_MENTION",
];

/** VERI_SOZLUGU.md §10: bu türler tek başına doğrulanmış hukuki ilişki değildir. */
const unverifiableByDefault = new Set<RelationType>(["TEXT_MENTION", "SPATIAL_INTERSECTION"]);

export function isRelationType(value: string): value is RelationType {
  return (relationTypes as string[]).includes(value);
}

export function requiresHumanVerification(type: RelationType) {
  return unverifiableByDefault.has(type);
}

/** Hukuki ekleri koruyarak ada/parsel değerini sadeleştirir: `12/a ` → `12/A`. */
export function normalizeParcelToken(value: string) {
  return value.trim().replace(/\s+/g, "").replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

function unknownOr(value: string | undefined | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\s+/g, " ") : UNKNOWN_IDENTITY;
}

export type ParcelInput = {
  blockNo: string;
  parcelNo: string;
  districtCode?: string | null;
  cadastralNeighborhood?: string | null;
  /** CBS parsel kimliği; verildiğinde varlık `ACTIVE` kabul edilir. */
  externalId?: string | null;
  sourceSystem?: string | null;
  geometryVersion?: string | null;
};

export type AddressInput = {
  neighborhood?: string | null;
  street?: string | null;
  doorNo?: string | null;
  unitNo?: string | null;
  externalId?: string | null;
  nationalAddressId?: string | null;
  sourceSystem?: string | null;
};

export type ResolvedEntity = { id: string; created: boolean; entityType: EntityType; displayLabel: string; entityStatus: string };

function parcelLabel(input: { cadastralNeighborhood: string; blockNo: string; parcelNo: string }) {
  const prefix = input.cadastralNeighborhood === UNKNOWN_IDENTITY ? "" : `${input.cadastralNeighborhood} `;
  return `${prefix}${input.blockNo} ada ${input.parcelNo} parsel`;
}

function addressLabel(parts: { neighborhood: string; street: string; doorNo: string; unitNo: string }) {
  const segments = [
    parts.neighborhood === UNKNOWN_IDENTITY ? null : `${parts.neighborhood} Mah.`,
    parts.street === UNKNOWN_IDENTITY ? null : parts.street,
    parts.doorNo === UNKNOWN_IDENTITY ? null : `No ${parts.doorNo}`,
    parts.unitNo ? `Daire ${parts.unitNo}` : null,
  ].filter(Boolean);
  return segments.length ? segments.join(" ") : "Belirlenmemiş adres";
}

/**
 * Parsel varlığını çözer; yoksa oluşturur.
 *
 * Dış kimlik yokken tekilleştirme (ilçe, kadastro mahallesi, ada, parsel)
 * dörtlüsüyle yapılır ve bilinmeyen alanlar `UNKNOWN` sabitiyle tutulur. Bu,
 * doğrulanmamış anmaları tek geçici varlıkta toplar; hukuki parsel kimliği
 * yerine geçmez.
 */
export async function resolveParcelEntity(db: D1Database, input: ParcelInput, actor: string): Promise<ResolvedEntity> {
  const blockNo = normalizeParcelToken(input.blockNo);
  const parcelNo = normalizeParcelToken(input.parcelNo);
  if (!blockNo || !parcelNo) throw new Error("Ada ve parsel değeri zorunludur.");
  const districtCode = unknownOr(input.districtCode);
  const cadastralNeighborhood = unknownOr(input.cadastralNeighborhood);
  const externalId = input.externalId?.trim() || null;
  const authoritySource = externalId ? (input.sourceSystem?.trim() || "KENT_REHBERI") : "ARCHIVE";
  const displayLabel = parcelLabel({ cadastralNeighborhood, blockNo, parcelNo });

  const existing = externalId
    ? await db.prepare(`SELECT e.id, e.entity_type, e.display_label, e.entity_status FROM entities e
        WHERE e.entity_type = 'PARCEL' AND e.authority_source = ? AND e.external_id = ? LIMIT 1`)
        .bind(authoritySource, externalId).first<{ id: string; entity_type: EntityType; display_label: string; entity_status: string }>()
    : await db.prepare(`SELECT e.id, e.entity_type, e.display_label, e.entity_status FROM entities e
        INNER JOIN parcel_entities p ON p.entity_id = e.id
        WHERE p.district_code = ? AND p.cadastral_neighborhood = ? AND p.block_no = ? AND p.parcel_no = ? LIMIT 1`)
        .bind(districtCode, cadastralNeighborhood, blockNo, parcelNo)
        .first<{ id: string; entity_type: EntityType; display_label: string; entity_status: string }>();
  if (existing) {
    return { id: existing.id, created: false, entityType: "PARCEL", displayLabel: existing.display_label, entityStatus: existing.entity_status };
  }

  const id = crypto.randomUUID();
  const entityStatus = externalId ? "ACTIVE" : "PROVISIONAL";
  try {
    await db.batch([
      db.prepare(`INSERT INTO entities (id, entity_type, display_label, authority_source, external_id, entity_status, created_by)
        VALUES (?, 'PARCEL', ?, ?, ?, ?, ?)`).bind(id, displayLabel, authoritySource, externalId, entityStatus, actor),
      db.prepare(`INSERT INTO parcel_entities
        (entity_id, parcel_external_id, district_code, cadastral_neighborhood, block_no, parcel_no, geometry_version, parcel_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, externalId, districtCode, cadastralNeighborhood, blockNo, parcelNo, input.geometryVersion?.trim() || null, externalId ? "CURRENT" : "UNKNOWN"),
    ]);
    return { id, created: true, entityType: "PARCEL", displayLabel, entityStatus };
  } catch {
    // Eşzamanlı istek aynı kimliği oluşturmuş olabilir; kazanan kayıt kullanılır.
    const winner = await db.prepare(`SELECT e.id, e.display_label, e.entity_status FROM entities e
      INNER JOIN parcel_entities p ON p.entity_id = e.id
      WHERE p.district_code = ? AND p.cadastral_neighborhood = ? AND p.block_no = ? AND p.parcel_no = ? LIMIT 1`)
      .bind(districtCode, cadastralNeighborhood, blockNo, parcelNo).first<{ id: string; display_label: string; entity_status: string }>();
    if (!winner) throw new Error("Parsel varlığı oluşturulamadı.");
    return { id: winner.id, created: false, entityType: "PARCEL", displayLabel: winner.display_label, entityStatus: winner.entity_status };
  }
}

/** Adres varlığını çözer; yoksa oluşturur. Tekilleştirme mahalle/yol/kapı üçlüsüyledir. */
export async function resolveAddressEntity(db: D1Database, input: AddressInput, actor: string): Promise<ResolvedEntity> {
  const neighborhood = unknownOr(input.neighborhood);
  const street = unknownOr(input.street);
  const doorNo = unknownOr(input.doorNo);
  const unitNo = input.unitNo?.trim().replace(/\s+/g, " ") ?? "";
  if (neighborhood === UNKNOWN_IDENTITY && street === UNKNOWN_IDENTITY && doorNo === UNKNOWN_IDENTITY) {
    throw new Error("Adres için en az mahalle, yol veya kapı numarası gereklidir.");
  }
  const externalId = input.externalId?.trim() || null;
  const authoritySource = externalId ? (input.sourceSystem?.trim() || "KENT_REHBERI") : "ARCHIVE";
  const displayLabel = addressLabel({ neighborhood, street, doorNo, unitNo });

  const existing = await db.prepare(`SELECT e.id, e.display_label, e.entity_status FROM entities e
    INNER JOIN address_entities a ON a.entity_id = e.id
    WHERE a.neighborhood = ? AND a.street = ? AND a.door_no = ? AND a.unit_no = ? LIMIT 1`)
    .bind(neighborhood, street, doorNo, unitNo).first<{ id: string; display_label: string; entity_status: string }>();
  if (existing) {
    return { id: existing.id, created: false, entityType: "ADDRESS", displayLabel: existing.display_label, entityStatus: existing.entity_status };
  }

  const id = crypto.randomUUID();
  const entityStatus = externalId ? "ACTIVE" : "PROVISIONAL";
  try {
    await db.batch([
      db.prepare(`INSERT INTO entities (id, entity_type, display_label, authority_source, external_id, entity_status, created_by)
        VALUES (?, 'ADDRESS', ?, ?, ?, ?, ?)`).bind(id, displayLabel, authoritySource, externalId, entityStatus, actor),
      db.prepare(`INSERT INTO address_entities
        (entity_id, address_external_id, national_address_id, neighborhood, street, door_no, unit_no, normalized_address)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, externalId, input.nationalAddressId?.trim() || null, neighborhood, street, doorNo, unitNo, displayLabel),
    ]);
    return { id, created: true, entityType: "ADDRESS", displayLabel, entityStatus };
  } catch {
    const winner = await db.prepare(`SELECT e.id, e.display_label, e.entity_status FROM entities e
      INNER JOIN address_entities a ON a.entity_id = e.id
      WHERE a.neighborhood = ? AND a.street = ? AND a.door_no = ? AND a.unit_no = ? LIMIT 1`)
      .bind(neighborhood, street, doorNo, unitNo).first<{ id: string; display_label: string; entity_status: string }>();
    if (!winner) throw new Error("Adres varlığı oluşturulamadı.");
    return { id: winner.id, created: false, entityType: "ADDRESS", displayLabel: winner.display_label, entityStatus: winner.entity_status };
  }
}

export type RelationInput = {
  documentId: string;
  entityId: string;
  relationType: RelationType;
  relationSource: RelationSource;
  relationConfidence?: number | null;
  verificationStatus: RelationVerification;
  evidence?: unknown;
  extractedFieldId?: string | null;
  actor: string;
};

/**
 * Belge-varlık ilişkisi ekler. Aynı (belge, varlık, ilişki türü) üçlüsü tekrar
 * gönderildiğinde kayıt güncellenir; doğrulanmış bir ilişki OCR önerisiyle
 * geri alınmaz.
 */
export function relationStatement(db: D1Database, input: RelationInput) {
  const verifiedBy = input.verificationStatus === "VERIFIED" ? input.actor : null;
  return db.prepare(`INSERT INTO document_entity_relations
    (id, document_id, entity_id, relation_type, relation_source, relation_confidence,
     verification_status, evidence_json, extracted_field_id, verified_by, verified_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_id, entity_id, relation_type) DO UPDATE SET
      relation_source = CASE WHEN document_entity_relations.verification_status = 'VERIFIED'
        THEN document_entity_relations.relation_source ELSE excluded.relation_source END,
      relation_confidence = excluded.relation_confidence,
      verification_status = CASE WHEN document_entity_relations.verification_status = 'VERIFIED' AND excluded.verification_status = 'SUGGESTED'
        THEN 'VERIFIED' ELSE excluded.verification_status END,
      evidence_json = excluded.evidence_json,
      extracted_field_id = COALESCE(excluded.extracted_field_id, document_entity_relations.extracted_field_id),
      verified_by = CASE WHEN excluded.verification_status = 'VERIFIED' THEN excluded.verified_by
        ELSE document_entity_relations.verified_by END,
      verified_at = CASE WHEN excluded.verification_status = 'VERIFIED' THEN excluded.verified_at
        ELSE document_entity_relations.verified_at END,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(
      crypto.randomUUID(), input.documentId, input.entityId, input.relationType, input.relationSource,
      input.relationConfidence ?? null, input.verificationStatus, JSON.stringify(input.evidence ?? {}),
      input.extractedFieldId ?? null, verifiedBy, verifiedBy ? new Date().toISOString() : null, input.actor,
    );
}

export type DocumentRelation = {
  id: string;
  entityId: string;
  entityType: EntityType;
  entityStatus: string;
  displayLabel: string;
  authoritySource: string;
  externalId: string | null;
  relationType: RelationType;
  relationSource: RelationSource;
  relationConfidence: number | null;
  verificationStatus: RelationVerification;
  evidence: unknown;
  verifiedBy: string | null;
  verifiedAt: string | null;
  createdAt: string;
  parcel: { districtCode: string; cadastralNeighborhood: string; blockNo: string; parcelNo: string } | null;
  address: { neighborhood: string; street: string; doorNo: string; unitNo: string } | null;
};

type RelationRow = {
  id: string; entity_id: string; entity_type: EntityType; entity_status: string; display_label: string;
  authority_source: string; external_id: string | null; relation_type: RelationType; relation_source: RelationSource;
  relation_confidence: number | null; verification_status: RelationVerification; evidence_json: string;
  verified_by: string | null; verified_at: string | null; created_at: string;
  district_code: string | null; cadastral_neighborhood: string | null; block_no: string | null; parcel_no: string | null;
  neighborhood: string | null; street: string | null; door_no: string | null; unit_no: string | null;
};

export async function listDocumentRelations(db: D1Database, documentId: string): Promise<DocumentRelation[]> {
  const result = await db.prepare(`SELECT r.id, r.entity_id, e.entity_type, e.entity_status, e.display_label,
      e.authority_source, e.external_id, r.relation_type, r.relation_source, r.relation_confidence,
      r.verification_status, r.evidence_json, r.verified_by, r.verified_at, r.created_at,
      p.district_code, p.cadastral_neighborhood, p.block_no, p.parcel_no,
      a.neighborhood, a.street, a.door_no, a.unit_no
    FROM document_entity_relations r
    INNER JOIN entities e ON e.id = r.entity_id
    LEFT JOIN parcel_entities p ON p.entity_id = e.id
    LEFT JOIN address_entities a ON a.entity_id = e.id
    WHERE r.document_id = ?
    ORDER BY CASE r.verification_status WHEN 'VERIFIED' THEN 0 WHEN 'SUGGESTED' THEN 1 ELSE 2 END,
      e.entity_type, e.display_label`).bind(documentId).all<RelationRow>();

  return result.results.map((row) => ({
    id: row.id,
    entityId: row.entity_id,
    entityType: row.entity_type,
    entityStatus: row.entity_status,
    displayLabel: row.display_label,
    authoritySource: row.authority_source,
    externalId: row.external_id,
    relationType: row.relation_type,
    relationSource: row.relation_source,
    relationConfidence: row.relation_confidence,
    verificationStatus: row.verification_status,
    evidence: parseEvidence(row.evidence_json),
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    parcel: row.block_no && row.parcel_no
      ? { districtCode: row.district_code ?? UNKNOWN_IDENTITY, cadastralNeighborhood: row.cadastral_neighborhood ?? UNKNOWN_IDENTITY, blockNo: row.block_no, parcelNo: row.parcel_no }
      : null,
    address: row.neighborhood || row.street || row.door_no
      ? { neighborhood: row.neighborhood ?? UNKNOWN_IDENTITY, street: row.street ?? UNKNOWN_IDENTITY, doorNo: row.door_no ?? UNKNOWN_IDENTITY, unitNo: row.unit_no ?? "" }
      : null,
  }));
}

function parseEvidence(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
