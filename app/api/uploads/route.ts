import { authorizeRequest, canAccessUnit } from "../../../lib/authorization";
import { DEFAULT_DOCUMENT_TYPE_CODE, UNIT_VOCABULARY_CODE } from "../../../lib/archive-seed";
import { loadProfileByCode, loadProfileByName, loadVocabularyTerms } from "../../../lib/document-profile";
import {
  createDigestStreamHasher,
  getArchiveBindings,
  getIngestStorages,
  jsonError,
  requireArchiveSchema,
} from "../../../lib/archive-storage";
import {
  createUploadSession,
  getUploadSession,
  ingestErrorResponse,
} from "../../../lib/ingest-service";
import { failure } from "../../../lib/errors";

export const dynamic = "force-dynamic";

function ingestFailure(error: unknown, request: Request) {
  return ingestErrorResponse(error)
    ?? failure(error, "uploads", "Yükleme oturumu işlenemedi.", request);
}

export async function POST(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "document.upload", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    const body = await request.json() as Record<string, unknown>;
    const requestedUnit = String(body.unit ?? "").trim();
    const requestedType = String(body.documentType ?? "").trim();
    const profile = requestedType
      ? await loadProfileByName(bindings.DB, requestedType)
      : await loadProfileByCode(bindings.DB, DEFAULT_DOCUMENT_TYPE_CODE);
    if (!profile) return jsonError("Belge türü yürürlükteki profiller arasında bulunamadı.");

    const unitTerms = await loadVocabularyTerms(bindings.DB, UNIT_VOCABULARY_CODE);
    const unitTerm = unitTerms?.find((term) => term.label === requestedUnit || term.code === requestedUnit);
    if (unitTerms && !unitTerm) return jsonError("Müdürlük değeri kontrollü listede bulunmuyor.");
    const unit = unitTerm?.label ?? requestedUnit;
    if (!unit || (!canAccessUnit(principal, requestedUnit) && !canAccessUnit(principal, unit))) {
      return jsonError("Bu müdürlük adına yükleme yetkiniz bulunmuyor.", 403);
    }
    const idempotencyKey = request.headers.get("idempotency-key") ?? String(body.idempotencyKey ?? "");
    const storages = getIngestStorages(bindings);
    const session = await createUploadSession({
      db: bindings.DB,
      ...storages,
      hasher: createDigestStreamHasher(),
    }, {
      userId: principal.email,
      unit,
      idempotencyKey,
      expectedByteSize: Number(body.byteSize),
      declaredMediaType: String(body.mediaType ?? ""),
      originalName: String(body.originalName ?? ""),
      requestedDocumentType: profile.name,
    });
    return Response.json({ session }, { status: session.resumed ? 200 : 201 });
  } catch (error) {
    return ingestFailure(error, request);
  }
}

export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "document.upload", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return jsonError("Yükleme oturumu kimliği gereklidir.");
    const storages = getIngestStorages(bindings);
    const session = await getUploadSession({
      db: bindings.DB,
      ...storages,
      hasher: createDigestStreamHasher(),
    }, id, principal.email);
    if (!canAccessUnit(principal, session.unit)) return jsonError("Oturum müdürlük kapsamınızın dışında.", 403);
    return Response.json({ session });
  } catch (error) {
    return ingestFailure(error, request);
  }
}

