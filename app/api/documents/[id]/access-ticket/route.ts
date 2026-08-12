import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  getArchiveBindings, isPendingDerivative, issueAccessTicket, jsonError,
  purposeForScope, requireArchiveSchema, resolveOriginalObject, resolveViewableObject,
  type AccessPurpose,
} from "../../../../../lib/archive-storage";
import { failure } from "../../../../../lib/errors";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

/** F1.9: belge+nesne+sınıf+kullanıcı+kapalı amaç koduna bağlı tek kullanımlık bilet. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const scope = body.scope === "DOWNLOAD" ? "DOWNLOAD" as const
      : body.scope === "VIEW" ? "VIEW" as const : null;
    if (!scope) return jsonError("Bilet kapsamı VIEW veya DOWNLOAD olmalıdır.");
    const expectedPurpose = purposeForScope(scope);
    const purpose = body.purpose as AccessPurpose | undefined;
    if (purpose !== expectedPurpose) return jsonError("Erişim amacı kapsamla uyuşmuyor.");

    const principal = await authorizeRequest(request, bindings.DB,
      scope === "DOWNLOAD" ? "document.download" : "document.read",
      bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const record = await bindings.DB.prepare("SELECT unit FROM archive_documents WHERE id = ?")
      .bind(id).first<{ unit: string }>();
    if (!record) return jsonError("Belge bulunamadı.", 404);
    if (!canAccessUnit(principal, record.unit)) {
      return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
    }

    const segmentValue = String(body.segment ?? "1");
    if (!/^[1-9]\d{0,3}$/.test(segmentValue)) {
      return jsonError("Türev bölüm numarası pozitif tam sayı olmalıdır.");
    }
    const resolved = scope === "DOWNLOAD"
      ? await resolveOriginalObject(bindings.DB, id)
        .then((object) => object && { object, objectClass: "original" as const })
      : await resolveViewableObject(bindings.DB, id, Number(segmentValue));
    if (!resolved) return jsonError("Belgenin nesne kaydı bulunamadı.", 404);
    if (isPendingDerivative(resolved)) {
      return jsonError("Güvenli görüntüleme kopyası henüz hazırlanıyor; lütfen daha sonra yeniden deneyin.", 425);
    }
    const expectedClass = scope === "VIEW" ? "access" : "original";
    const expectedNamespace = scope === "VIEW" ? "DERIVATIVE_FILES" : "ARCHIVE_FILES";
    if (resolved.objectClass !== expectedClass
      || resolved.object.bucket_or_namespace !== expectedNamespace) {
      return jsonError("İstenen erişim kapsamına uygun güvenli nesne bulunamadı.", 425);
    }

    const ticket = await issueAccessTicket(bindings.DB, {
      userId: principal.email,
      documentId: id,
      binaryObjectId: resolved.object.id,
      scope,
      purpose,
    });
    return Response.json({
      ticket: ticket.token,
      expiresAt: ticket.expiresAt,
      scope,
      segment: "segment" in resolved ? resolved.segment ?? null : null,
    }, { status: 201, headers: { "cache-control": "no-store, private" } });
  } catch (error) {
    return failure(error, "documents.access-ticket", "Erişim bileti üretilemedi.", request);
  }
}