import { prepareAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import { ensureArchiveSchema, getArchiveBindings, jsonError } from "../../../../../lib/archive-storage";
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
  await ensureArchiveSchema(bindings.DB);
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
  await ensureArchiveSchema(bindings.DB);
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

    const audit = await prepareAuditEvent(DB, {
      documentId: id,
      actor: principal.email,
      action: "relation.verified",
      details: {
        entityId: entity.id, entityType: entity.entityType, entityStatus: entity.entityStatus,
        displayLabel: entity.displayLabel, relationType, relationSource: "HUMAN",
        entityCreated: entity.created, note: text(body.note, 300) || null,
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
    return jsonError(error instanceof Error ? error.message : "İlişki kaydedilemedi.");
  }
}

type SubmittedRelation = { id?: unknown; action?: unknown; reason?: unknown };
type RelationRow = { id: string; entity_id: string; relation_type: string; relation_source: string; verification_status: string; display_label: string };

/** OCR önerisi olan ilişkileri personel onayına veya reddine bağlar. */
export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  await ensureArchiveSchema(bindings.DB);
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
    reason: typeof entry.reason === "string" ? entry.reason.trim().slice(0, 300) : "",
  }));
  if (operations.some((operation) => !operation.id || !["verify", "reject"].includes(operation.action))) {
    return jsonError("Her ilişki için `verify` veya `reject` eylemi gereklidir.");
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
      reason: operation.reason || undefined,
    };
  }).sort((left, right) => left.relationId.localeCompare(right.relationId));

  const audit = await prepareAuditEvent(DB, {
    documentId: id,
    actor: principal.email,
    action: changes.every((change) => change.to === "REJECTED") ? "relation.rejected" : "relation.verified",
    details: { changes },
  });
  const statements = operations.map((operation) => operation.action === "verify"
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
