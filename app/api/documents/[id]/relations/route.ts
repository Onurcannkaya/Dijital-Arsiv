import { prepareAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import { requireArchiveSchema, getArchiveBindings, jsonError } from "../../../../../lib/archive-storage";
import { failure } from "../../../../../lib/errors";
import {
  RELATION_REJECTION_REASONS, type ValidatedRejection, validateRejection,
} from "../../../../../lib/rejection-reasons";
import {
  isRelationType, listDocumentRelations, relationStatement,
  resolveAddressEntity, resolveParcelEntity, type RelationType,
} from "../../../../../lib/entities";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type DocumentState = { status: string; unit: string };

async function loadDocument(db: D1Database, id: string) {
  return await db.prepare("SELECT status, unit FROM archive_documents WHERE id = ?").bind(id).first<DocumentState>();
}

function text(value: unknown, limit = 160) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, limit) : "";
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const document = await loadDocument(bindings.DB, id);
  if (!document) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, document.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  return Response.json({ relations: await listDocumentRelations(bindings.DB, id) });
}

/**
 * Belgeye varlık ilişkisi ekler.
 *
 * Bir belge birden çok parsel ve adresle ilişkilendirilebilir
 * (ANA_SISTEM_TASARIM_BELGESI.md §15). Personelin kurduğu ilişki `VERIFIED`
 * kaydedilir; varlığın kendisi CBS dış kimliği yoksa `PROVISIONAL` kalır.
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const principal = await authorizeRequest(request, bindings.DB, "document.review", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const DB = bindings.DB;

  let body: { parcel?: Record<string, unknown>; address?: Record<string, unknown>; relationType?: unknown; note?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonError("Geçerli bir ilişki isteği gönderilmelidir.");
  }
  const relationType = text(body.relationType, 40) || "SUBJECT";
  if (!isRelationType(relationType)) return jsonError("İlişki türü kontrollü sözlükte bulunmuyor.");
  if (Boolean(body.parcel) === Boolean(body.address)) {
    return jsonError("Tek istekte bir parsel veya bir adres gönderilmelidir.");
  }

  const document = await loadDocument(DB, id);
  if (!document) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, document.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  if (document.status === "archived") return jsonError("Arşivlenmiş belgenin ilişkileri değiştirilemez.", 409);

  try {
    const entity = body.parcel
      ? await resolveParcelEntity(DB, {
          blockNo: text(body.parcel.blockNo, 24),
          parcelNo: text(body.parcel.parcelNo, 24),
          districtCode: text(body.parcel.districtCode, 80) || null,
          cadastralNeighborhood: text(body.parcel.cadastralNeighborhood, 120) || null,
          externalId: text(body.parcel.externalId, 120) || null,
          sourceSystem: text(body.parcel.sourceSystem, 60) || null,
          geometryVersion: text(body.parcel.geometryVersion, 60) || null,
        }, principal.email)
      : await resolveAddressEntity(DB, {
          neighborhood: text(body.address!.neighborhood, 120) || null,
          street: text(body.address!.street, 160) || null,
          doorNo: text(body.address!.doorNo, 24) || null,
          unitNo: text(body.address!.unitNo, 24) || null,
          externalId: text(body.address!.externalId, 120) || null,
          nationalAddressId: text(body.address!.nationalAddressId, 120) || null,
          sourceSystem: text(body.address!.sourceSystem, 60) || null,
        }, principal.email);

    /*
     * Aynı varlık ikinci kez gönderildiğinde (çift tıklama, zaman aşımı sonrası
     * yeniden deneme) ne yeni varlık ne yeni ilişki oluşur. Buna rağmen denetim
     * olayı yazmak, olmamış bir insan kararını değişmez zincire kalıcı olarak
     * geçirir: denetçi iki ilişki için dört "doğrulandı" görür. Zaten
     * doğrulanmış bir ilişkiyi yeniden göndermek karar değildir.
     *
     * Öneri ya da reddedilmiş durumdaki bir ilişkiyi doğrulamak ise gerçek bir
     * karardır ve kayda geçer.
     */
    const existing = await DB.prepare(`SELECT verification_status FROM document_entity_relations
      WHERE document_id = ? AND entity_id = ? AND relation_type = ?`)
      .bind(id, entity.id, relationType).first<{ verification_status: string }>();
    if (existing?.verification_status === "VERIFIED") {
      return Response.json({
        saved: false,
        unchanged: true,
        entity: { id: entity.id, entityType: entity.entityType, displayLabel: entity.displayLabel, entityStatus: entity.entityStatus, created: false },
        relationType,
        message: "Bu ilişki zaten doğrulanmış; kayıt değişmedi.",
        relations: await listDocumentRelations(DB, id),
      });
    }

    const audit = await prepareAuditEvent(DB, {
      documentId: id,
      actor: principal.email,
      action: "relation.verified",
      details: {
        entityId: entity.id, entityType: entity.entityType, entityStatus: entity.entityStatus,
        displayLabel: entity.displayLabel, relationType, relationSource: "HUMAN",
        entityCreated: entity.created, note: text(body.note, 300) || null,
        previousStatus: existing?.verification_status ?? null,
      },
    });
    await DB.batch([
      relationStatement(DB, {
        documentId: id,
        entityId: entity.id,
        relationType: relationType as RelationType,
        relationSource: "HUMAN",
        relationConfidence: null,
        verificationStatus: "VERIFIED",
        evidence: { recordedBy: principal.email, note: text(body.note, 300) || null },
        actor: principal.email,
      }),
      DB.prepare("UPDATE archive_documents SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
      audit.statement,
    ]);
    return Response.json({
      saved: true,
      entity: { id: entity.id, entityType: entity.entityType, displayLabel: entity.displayLabel, entityStatus: entity.entityStatus, created: entity.created },
      relationType,
      auditEvent: audit.eventNumber,
      relations: await listDocumentRelations(DB, id),
    }, { status: 201 });
  } catch (error) {
    return failure(error, "relations.create", "İlişki kaydedilemedi.", request);
  }
}

type SubmittedRelation = { id?: unknown; action?: unknown; reasonCode?: unknown; reasonNote?: unknown };
type RelationRow = { id: string; entity_id: string; relation_type: string; relation_source: string; verification_status: string; display_label: string };

/** OCR önerisi olan ilişkileri personel onayına veya reddine bağlar. */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const principal = await authorizeRequest(request, bindings.DB, "document.review", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const DB = bindings.DB;

  let body: { relations?: SubmittedRelation[] };
  try {
    body = await request.json() as { relations?: SubmittedRelation[] };
  } catch {
    return jsonError("Geçerli bir ilişki listesi gönderilmelidir.");
  }
  const submitted = Array.isArray(body.relations) ? body.relations : [];
  if (!submitted.length || submitted.length > 60) return jsonError("En az bir, en fazla 60 ilişki gönderilebilir.");
  const operations = submitted.map((entry) => ({
    id: typeof entry.id === "string" ? entry.id : "",
    action: typeof entry.action === "string" ? entry.action : "",
    rejection: entry,
  }));
  if (operations.some((operation) => !operation.id || !["verify", "reject"].includes(operation.action))) {
    return jsonError("Her ilişki için `verify` veya `reject` eylemi gereklidir.");
  }
  /*
   * Ret gerekçesi zorunludur: değişmez izde "kim ve ne zaman" duruyordu ama
   * "neden" durmuyordu, oysa taşınmaz dosyasında yıllar sonra sorulacak soru
   * budur. Kontrollü kod, serbest metnin üreteceği raporlanamaz girdileri
   * önler ve OCR'ın nerede yanıldığının ölçülmesini sağlar.
   */
  const rejectionByRelation = new Map<string, ValidatedRejection>();
  for (const operation of operations) {
    if (operation.action !== "reject") continue;
    const validated = validateRejection(operation.rejection, RELATION_REJECTION_REASONS);
    if (typeof validated === "string") return jsonError(validated);
    rejectionByRelation.set(operation.id, validated);
  }
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
    return jsonError("Aynı ilişki birden fazla gönderilemez.");
  }

  const document = await loadDocument(DB, id);
  if (!document) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, document.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  if (document.status === "archived") return jsonError("Arşivlenmiş belgenin ilişkileri değiştirilemez.", 409);

  const stored = await DB.prepare(`SELECT r.id, r.entity_id, r.relation_type, r.relation_source,
    r.verification_status, e.display_label FROM document_entity_relations r
    INNER JOIN entities e ON e.id = r.entity_id WHERE r.document_id = ?`).bind(id).all<RelationRow>();
  const byId = new Map(stored.results.map((row) => [row.id, row]));
  if (operations.some((operation) => !byId.has(operation.id))) return jsonError("Belgede bulunmayan bir ilişki gönderildi.");

  const changes = operations.map((operation) => {
    const current = byId.get(operation.id)!;
    return {
      relationId: operation.id, entityId: current.entity_id, displayLabel: current.display_label,
      relationType: current.relation_type, from: current.verification_status,
      to: operation.action === "verify" ? "VERIFIED" : "REJECTED",
      ...(rejectionByRelation.get(operation.id) ?? {}),
    };
  }).sort((left, right) => left.relationId.localeCompare(right.relationId))
    /*
     * Durumu değiştirmeyen işlem karar değildir. Yazılırsa değişmez zincire
     * `from === to` olan bir "doğrulandı"/"reddedildi" olayı girer ve denetçi,
     * olmamış bir insan kararını okur. Çift tıklama ya da zaman aşımı sonrası
     * yeniden gönderim bunu kolayca üretir.
     */
    .filter((change) => change.from !== change.to);

  if (!changes.length) {
    return Response.json({
      saved: false, unchanged: true, verified: 0, rejected: 0,
      message: "Gönderilen ilişkiler zaten bu durumdaydı; kayıt değişmedi.",
      relations: await listDocumentRelations(DB, id),
    });
  }

  const changedIds = new Set(changes.map((change) => change.relationId));
  const audit = await prepareAuditEvent(DB, {
    documentId: id,
    actor: principal.email,
    action: changes.every((change) => change.to === "REJECTED") ? "relation.rejected" : "relation.verified",
    details: { changes },
  });
  const statements = operations.filter((operation) => changedIds.has(operation.id))
    .map((operation) => operation.action === "verify"
    ? DB.prepare(`UPDATE document_entity_relations SET verification_status = 'VERIFIED',
        verified_by = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND document_id = ?`).bind(principal.email, operation.id, id)
    : DB.prepare(`UPDATE document_entity_relations SET verification_status = 'REJECTED',
        verified_by = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND document_id = ?`).bind(principal.email, operation.id, id));
  statements.push(DB.prepare("UPDATE archive_documents SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id));
  statements.push(audit.statement);
  await DB.batch(statements);

  return Response.json({
    saved: true,
    verified: changes.filter((change) => change.to === "VERIFIED").length,
    rejected: changes.filter((change) => change.to === "REJECTED").length,
    auditEvent: audit.eventNumber,
    relations: await listDocumentRelations(DB, id),
  });
}
