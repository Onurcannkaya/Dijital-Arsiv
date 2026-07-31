import { writeAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  getArchiveBindings, isPendingDerivative, issueAccessTicket, jsonError,
  requireArchiveSchema, resolveOriginalObject, resolveViewableObject,
} from "../../../../../lib/archive-storage";
import { failure } from "../../../../../lib/errors";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

/**
 * F1.9 / ADR-015 — Tek kullanımlık erişim bileti üretir.
 *
 * - `VIEW`: `document.read` yetkisiyle görüntülenebilir nesneye (erişim türevi;
 *   PDF'te tamamlanmış üretim kuşağının seçili bölümü) bağlanır.
 * - `DOWNLOAD`: `document.download` yetkisiyle değiştirilemez asıla bağlanır.
 *
 * Bilet kullanıcı+belge+nesne+amaç kapsamındadır, 60 saniye geçerlidir ve bir
 * kez tüketilir. Açık token yalnız bu yanıtta görünür; veritabanı özet tutar.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const scope = body.scope === "DOWNLOAD" ? "DOWNLOAD" as const : body.scope === "VIEW" ? "VIEW" as const : null;
    if (!scope) return jsonError("Bilet kapsamı VIEW veya DOWNLOAD olmalıdır.");
    const purpose = String(body.purpose ?? "").trim().slice(0, 120);
    if (!purpose) return jsonError("Erişim amacı zorunludur.");

    const principal = await authorizeRequest(request, bindings.DB,
      scope === "DOWNLOAD" ? "document.download" : "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const record = await bindings.DB.prepare(
      "SELECT unit, reference_no FROM archive_documents WHERE id = ?",
    ).bind(id).first<{ unit: string; reference_no: string }>();
    if (!record) return jsonError("Belge bulunamadı.", 404);
    if (!canAccessUnit(principal, record.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);

    const segmentValue = String(body.segment ?? "1");
    if (!/^[1-9]\d{0,3}$/.test(segmentValue)) {
      return jsonError("Türev bölüm numarası pozitif tam sayı olmalıdır.");
    }
    const resolved = scope === "DOWNLOAD"
      ? await resolveOriginalObject(bindings.DB, id).then((object) => object && { object, objectClass: "original" as const })
      : await resolveViewableObject(bindings.DB, id, Number(segmentValue));
    if (!resolved) return jsonError("Belgenin nesne kaydı bulunamadı.", 404);
    if (isPendingDerivative(resolved)) {
      return jsonError("Güvenli görüntüleme kopyası henüz hazırlanıyor; lütfen daha sonra yeniden deneyin.", 425);
    }

    const ticket = await issueAccessTicket(bindings.DB, {
      userId: principal.email,
      binaryObjectId: resolved.object.id,
      scope,
      purpose,
    });
    // Denetim açık token içermez; bilet kimliği ve kapsam kanıt için yeterlidir.
    await writeAuditEvent(bindings.DB, {
      documentId: id,
      actor: principal.email,
      action: "document.ticket-issued",
      details: {
        referenceNo: record.reference_no,
        ticketId: ticket.ticketId,
        scope,
        purpose,
        objectClass: resolved.objectClass,
        sha256: resolved.object.sha256,
      },
    });
    return Response.json({
      ticket: ticket.token,
      expiresAt: ticket.expiresAt,
      scope,
      segment: "segment" in resolved ? resolved.segment ?? null : null,
    }, { status: 201 });
  } catch (error) {
    return failure(error, "documents.access-ticket", "Erişim bileti üretilemedi.", request);
  }
}
