import { authorizeRequest } from "../../../lib/authorization";
import { getArchiveBindings, jsonError, requireArchiveSchema } from "../../../lib/archive-storage";
import { decodeActivityCursor, listActivity, type ActivityKind } from "../../../lib/activity-log";
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
    /*
     * Basamak sayısı aralık denetimi değildir: `0` ve `999` desenden geçip
     * sessizce 1'e ve 100'e kırpılıyordu. İstemci istediğinden başka bir
     * sayfa boyutu alıp bunu bilmiyordu; kural 1–100 diyorsa aralık dışı
     * değer reddedilmelidir.
     */
    const rawLimit = parameters.get("limit");
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!/^\d+$/.test(rawLimit) || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return jsonError("`limit` 1 ile 100 arasında bir tam sayı olmalıdır.");
      }
    }

    /*
     * Çözülemeyen imleç sessizce yok sayılıyor ve İLK sayfa dönüyordu. Denetim
     * izini sayfa sayfa okuyan biri bozuk bir imleçle farkında olmadan başa
     * döner ve döngüde kalıp izin tamamını gördüğünü sanır.
     */
    const rawCursor = parameters.get("cursor");
    if (rawCursor !== null && !decodeActivityCursor(rawCursor)) {
      return jsonError("`cursor` değeri geçersiz.");
    }
    const includeUserEvents = principal.permissions.includes("users.manage");

    const page = await listActivity(bindings.DB, {
      unit: principal.unit,
      includeUserEvents,
      kind: rawKind as ActivityKind | "all",
      limit: rawLimit ? Number(rawLimit) : undefined,
      cursor: rawCursor,
    });
    return Response.json({
      ...page,
      scope: { unit: principal.unit, includesUserEvents: includeUserEvents },
    }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) {
    return failure(error, "activity.list", "İşlem geçmişi alınamadı.", request);
  }
}
