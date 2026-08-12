import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  createDigestStreamHasher,
  getArchiveBindings,
  getIngestStorages,
  jsonError,
  requireArchiveSchema,
} from "../../../../../lib/archive-storage";
import {
  completeUploadSession,
  getUploadSession,
  ingestErrorResponse,
} from "../../../../../lib/ingest-service";
import { failure } from "../../../../../lib/errors";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "document.upload", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    const { id } = await context.params;
    const storages = getIngestStorages(bindings);
    const dependencies = { db: bindings.DB, ...storages, hasher: createDigestStreamHasher() };
    const current = await getUploadSession(dependencies, id, principal.email);
    if (!canAccessUnit(principal, current.unit)) return jsonError("Oturum müdürlük kapsamınızın dışında.", 403);
    const session = await completeUploadSession(dependencies, id, principal.email);
    return Response.json({ session });
  } catch (error) {
    return ingestErrorResponse(error)
      ?? failure(error, "uploads.complete", "Yükleme tamamlanamadı.", request);
  }
}
