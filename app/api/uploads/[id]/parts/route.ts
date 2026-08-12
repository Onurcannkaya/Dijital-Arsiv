import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  createDigestStreamHasher,
  getArchiveBindings,
  getIngestStorages,
  jsonError,
  requireArchiveSchema,
} from "../../../../../lib/archive-storage";
import {
  getUploadSession,
  ingestErrorResponse,
  uploadPart,
} from "../../../../../lib/ingest-service";
import { failure } from "../../../../../lib/errors";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

function ingestFailure(error: unknown, request: Request) {
  return ingestErrorResponse(error)
    ?? failure(error, "uploads.parts", "Yükleme parçası işlenemedi.", request);
}

async function contextFor(request: Request, context: RouteContext) {
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return { response: schemaError } as const;
  const principal = await authorizeRequest(request, bindings.DB, "document.upload", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return { response: principal } as const;
  const { id } = await context.params;
  const storages = getIngestStorages(bindings);
  const dependencies = { db: bindings.DB, ...storages, hasher: createDigestStreamHasher() };
  const session = await getUploadSession(dependencies, id, principal.email);
  if (!canAccessUnit(principal, session.unit)) return { response: jsonError("Oturum müdürlük kapsamınızın dışında.", 403) } as const;
  return { bindings, principal, id, dependencies, session } as const;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const result = await contextFor(request, context);
    if ("response" in result) return result.response;
    return Response.json({ session: result.session });
  } catch (error) {
    return ingestFailure(error, request);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const result = await contextFor(request, context);
    if ("response" in result) return result.response;
    const body = request.body;
    if (!body) return jsonError("Parça gövdesi gereklidir.");
    const partNumber = Number(request.headers.get("x-part-number"));
    const byteSize = Number(request.headers.get("content-length"));
    const checksumSha256 = request.headers.get("x-content-sha256") ?? "";
    if (!Number.isSafeInteger(byteSize) || byteSize < 1) return jsonError("Geçerli Content-Length gereklidir.", 411);
    const session = await uploadPart(result.dependencies, {
      sessionId: result.id,
      userId: result.principal.email,
      partNumber,
      byteSize,
      checksumSha256,
      body,
    });
    return Response.json({ session });
  } catch (error) {
    return ingestFailure(error, request);
  }
}

