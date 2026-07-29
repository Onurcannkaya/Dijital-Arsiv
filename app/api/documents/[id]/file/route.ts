import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import { ensureArchiveSchema, getArchiveBindings, jsonError, resolveOriginalObject } from "../../../../../lib/archive-storage";

type RouteContext = { params: Promise<{ id: string }> };
type FileRecord = { original_name:string; unit:string };

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  await ensureArchiveSchema(bindings.DB);
  const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const record = await bindings.DB.prepare("SELECT original_name, unit FROM archive_documents WHERE id = ?").bind(id).first<FileRecord>();
  if (!record) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, record.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  // Depolama konumu nesne kaydından çözülür (S3_DEPOLAMA... §8).
  const original = await resolveOriginalObject(bindings.DB, id);
  if (!original) return jsonError("Belgenin asıl nesne kaydı bulunamadı.", 404);
  const object = await bindings.ARCHIVE_FILES.get(original.object_key);
  if (!object) return jsonError("Asıl dosya kasada bulunamadı.", 404);
  const safeName = record.original_name.replace(/[\r\n"]/g, "_");
  return new Response(object.body, { headers:{ "content-type":original.media_type, "content-length":String(object.size), "content-disposition":`inline; filename="${safeName}"`, "cache-control":"private, max-age=60", "x-content-type-options":"nosniff" } });
}