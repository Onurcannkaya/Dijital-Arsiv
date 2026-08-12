import { authorizeRequest } from "../../../lib/authorization";
import { getArchiveBindings, jsonError, requireArchiveSchema } from "../../../lib/archive-storage";
import { listActivity, type ActivityKind } from "../../../lib/activity-log";
import { failure } from "../../../lib/errors";

export const dynamic = "force-dynamic";

/**
 * Kurum geneli işlem geçmişi.
 *
 * Erişim `document.read` ile açılır, ama içerik kapsamla sınırlıdır: belge
 * olayları kullanıcının müdürlük kapsamına göre süzülür (lib/activity-log.ts)
 * ve yetki olayları yalnız `users.manage` yetkisi olanlara verilir.
 */
export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const parameters = new URL(request.url).searchParams;
    const rawKind = parameters.get("kind") ?? "all";
    if (!["all", "document", "user"].includes(rawKind)) {
      return jsonError("`kind` değeri all, document veya user olmalıdır.");
    }
    const rawLimit = parameters.get("limit");
    if (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) {
      return jsonError("`limit` 1 ile 100 arasında bir tam sayı olmalıdır.");
    }
    const includeUserEvents = principal.permissions.includes("users.manage");

    const page = await listActivity(bindings.DB, {
      unit: principal.unit,
      includeUserEvents,
      kind: rawKind as ActivityKind | "all",
      limit: rawLimit ? Number(rawLimit) : undefined,
      cursor: parameters.get("cursor"),
    });
    return Response.json({
      ...page,
      scope: { unit: principal.unit, includesUserEvents: includeUserEvents },
    }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) {
    return failure(error, "activity.list", "İşlem geçmişi alınamadı.", request);
  }
}
