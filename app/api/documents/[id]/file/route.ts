import { writeAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  getObjectReaderForNamespace, requireArchiveSchema, getArchiveBindings, isPendingDerivative,
  jsonError, resolveOriginalObject, resolveViewableObject,
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
 * F1.7/ADR-015: PDF görüntüleme HİÇBİR durumda asıl sınıfına düşmez; türev
 * hazır değilse 425 döner ve geri dolum işi türevi üretene kadar beklenir.
 * Bölümlü türevlerde `?segment=N` ile sonraki bölümler istenir; PDF dışı
 * türlerde asıl fallback geçici olarak sürer ve denetim kaydına yazılır.
 *
 * İkisi de denetlenir. Denetim kaydı yazılamazsa dosya sunulmaz: erişimin
 * izlenebilir olmadığı durumda erişim verilmemelidir.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
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
  const segmentValue = url.searchParams.get("segment") ?? "1";
  if (!isDownload && !/^[1-9]\d*$/.test(segmentValue)) {
    return jsonError("Türev bölüm numarası pozitif tam sayı olmalıdır.", 400);
  }
  const segment = Number(segmentValue);
  if (!isDownload && !Number.isSafeInteger(segment)) {
    return jsonError("Türev bölüm numarası geçersiz.", 400);
  }
  const resolved = isDownload
    ? await resolveOriginalObject(bindings.DB, id).then((object) => object && { object, objectClass: "original" as const })
    : await resolveViewableObject(bindings.DB, id, segment);
  if (!resolved) return jsonError("Belgenin nesne kaydı bulunamadı.", 404);
  if (!isDownload && isPendingDerivative(resolved)) {
    // ADR-015: asıl PDF görüntülemeye sunulmaz; türev geri dolum işi üretecek.
    return jsonError("Güvenli görüntüleme kopyası henüz hazırlanıyor; lütfen daha sonra yeniden deneyin.", 425);
  }
  if (isPendingDerivative(resolved)) return jsonError("Belgenin nesne kaydı bulunamadı.", 404);
  let object;
  try {
    const reader = getObjectReaderForNamespace(bindings, resolved.object.bucket_or_namespace);
    object = await reader.get(resolved.object.object_key);
  } catch {
    return jsonError("Belge depolama okuma rolü kullanılamıyor.", 503);
  }
  if (!object) return jsonError("Dosya kasada bulunamadı.", 404);
  if (object.range !== null || object.size !== resolved.object.byte_size
    || (object.contentType && object.contentType !== resolved.object.media_type)) {
    return jsonError("Dosya kasası kanıtı yetkili nesne kaydıyla uyuşmuyor.", 503);
  }

  try {
    await writeAuditEvent(bindings.DB, {
      documentId: id,
      actor: principal.email,
      action: isDownload ? "document.downloaded" : "document.viewed",
      details: {
        referenceNo: record.reference_no,
        // Sunulan sınıf ve kuşak kanıtı denetim zincirine yazılır.
        servedObjectClass: resolved.objectClass,
        sha256: resolved.object.sha256, byteSize: resolved.object.byte_size,
        generationId: resolved.object.derivative_generation_id ?? null, purpose,
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
      // Bölümlü türevde istemci sonraki bölümleri ?segment=N ile ister.
      ...("segment" in resolved && resolved.segment ? {
        "x-archive-segment": String(resolved.segment.index),
        "x-archive-segment-count": String(resolved.segment.total),
      } : {}),
    },
  });
}
