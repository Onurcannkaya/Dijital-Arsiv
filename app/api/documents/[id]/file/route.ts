import { writeAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  getArchiveObjectStorage, requireArchiveSchema, getArchiveBindings, jsonError,
  resolveOriginalObject, resolveViewableObject,
} from "../../../../../lib/archive-storage";

type RouteContext = { params: Promise<{ id: string }> };
type FileRecord = { original_name:string; unit:string; reference_no:string };

/**
 * Belge dosyasını yetkiye bağlı olarak sunar.
 *
 * Görüntüleme ve indirme ayrı yetkilerdir ve **ayrı nesneler** döndürür:
 * - `document.read` → kontrollü erişim türevi (`access`)
 * - `document.download` → değiştirilemez asıl (`original`)
 *
 * Web'de görüntülenen içeriğin kaydedilmesi tamamen engellenemez; korunabilecek
 * sınır asıl dosyadır (S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5, §11.2).
 * Erişim türevi henüz üretilmemiş belgelerde (örneğin PDF'ler) görüntüleme asılı
 * sunmak zorunda kalır; bu durum denetim kaydına `servedObjectClass` olarak
 * yazılır ve eksik türev sayısı `/api/overview` içinde raporlanır.
 *
 * İkisi de denetlenir. Denetim kaydı yazılamazsa dosya sunulmaz: erişimin
 * izlenebilir olmadığı durumda erişim verilmemelidir.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const objectStorage = getArchiveObjectStorage(bindings);
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const url = new URL(request.url);
  const isDownload = url.searchParams.get("download") === "1";
  const purpose = url.searchParams.get("purpose")?.trim().slice(0, 60) || null;

  const principal = await authorizeRequest(request, bindings.DB, isDownload ? "document.download" : "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const record = await bindings.DB.prepare("SELECT original_name, unit, reference_no FROM archive_documents WHERE id = ?").bind(id).first<FileRecord>();
  if (!record) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, record.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);

  // Depolama konumu nesne kaydından çözülür (S3_DEPOLAMA... §8).
  const resolved = isDownload
    ? await resolveOriginalObject(bindings.DB, id).then((object) => object && { object, objectClass: "original" as const })
    : await resolveViewableObject(bindings.DB, id);
  if (!resolved) return jsonError("Belgenin nesne kaydı bulunamadı.", 404);
  const object = await objectStorage.get(resolved.object.object_key);
  if (!object) return jsonError("Dosya kasada bulunamadı.", 404);

  try {
    await writeAuditEvent(bindings.DB, {
      documentId: id,
      actor: principal.email,
      action: isDownload ? "document.downloaded" : "document.viewed",
      details: {
        referenceNo: record.reference_no,
        // Hangi sınıfın sunulduğu kaydedilir: türev yoksa asıl sunulmuştur.
        servedObjectClass: resolved.objectClass,
        sha256: resolved.object.sha256, byteSize: resolved.object.byte_size, purpose,
      },
    });
  } catch {
    return jsonError("Erişim denetim kaydı oluşturulamadı; dosya sunulmadı.", 503);
  }

  const safeName = record.original_name.replace(/[\r\n"]/g, "_");
  return new Response(object.body, {
    headers: {
      "content-type": resolved.object.media_type,
      "content-length": String(object.size),
      "content-disposition": `${isDownload ? "attachment" : "inline"}; filename="${safeName}"`,
      // Belge içeriği paylaşılan önbelleklere ve tarayıcı diskine yazılmamalıdır.
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "x-archive-object-class": resolved.objectClass,
    },
  });
}
