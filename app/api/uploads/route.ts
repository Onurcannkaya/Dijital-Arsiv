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
import { ACCEPTED_FILE_EXTENSIONS, isAcceptedMediaType, isOperatorRetryWindowOpen } from "../../../lib/ingest-contract";
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
    /*
     * Bildirilen tür hiç desteklenmiyorsa oturumu açmanın anlamı yok: memur
     * 2 GiB'a kadar dosyayı boşuna yükler ve ret ancak taramada gelir.
     * İçeriğe bakan asıl denetim yine tarama servisindedir (K-1); bu yalnız
     * baştan bilinebileni baştan söyler.
     */
    const declaredMediaType = String(body.mediaType ?? "").trim().toLowerCase();
    if (!isAcceptedMediaType(declaredMediaType)) {
      return jsonError(`Desteklenmeyen belge biçimi. Kabul edilenler: ${ACCEPTED_FILE_EXTENSIONS.join(", ")}.`,
        400, "UNSUPPORTED_MEDIA_TYPE");
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
      declaredMediaType,
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
    const url = new URL(request.url);
    /*
     * `scope=failed` operatör görünümüdür: ADR-013 kurtarma komutunun hedefi
     * olan FAILED oturumları KULLANICI süzgeci olmadan, müdürlük kapsamıyla
     * listeler. Kendi oturum listesi `document.upload` ile yetinirken bu
     * görünüm kurtarma yetkisini ister — başkasının yüklemesini görmek,
     * onu kurtarabilecek role aittir.
     */
    if (url.searchParams.get("scope") === "failed") {
      const operator = await authorizeRequest(request, bindings.DB, "ingest.retry", bindings.ARCHIVE_ADMIN_EMAILS);
      if (operator instanceof Response) return operator;
      const failed = await bindings.DB.prepare(`SELECT s.id, s.user_id, s.unit, s.original_name,
          s.requested_document_type, s.failure_code, s.operator_retry_reason, s.updated_at,
          (SELECT e.created_at FROM upload_session_events e
            WHERE e.upload_session_id = s.id AND e.to_status = 'FAILED'
            ORDER BY e.event_number DESC LIMIT 1) AS failed_at,
          (SELECT 1 FROM ingest_receipts r
            WHERE r.upload_session_id = s.id AND r.result = 'VERIFIED' AND r.scanner_result = 'CLEAN'
            LIMIT 1) AS has_receipt,
          (SELECT 1 FROM ingest_objects o
            WHERE o.upload_session_id = s.id AND o.object_class = 'quarantine' AND o.deleted_at IS NULL
            LIMIT 1) AS has_quarantine
        FROM upload_sessions s
        WHERE s.status = 'FAILED' AND (? = '*' OR s.unit = ?)
        ORDER BY s.updated_at DESC LIMIT 50`)
        .bind(operator.unit, operator.unit)
        .all<{ id: string; user_id: string; unit: string; original_name: string;
          requested_document_type: string; failure_code: string | null;
          operator_retry_reason: string | null; updated_at: string; failed_at: string | null;
          has_receipt: number | null; has_quarantine: number | null }>();
      const now = new Date();
      return Response.json({
        sessions: failed.results.map((row) => ({
          id: row.id,
          uploadedBy: row.user_id,
          unit: row.unit,
          originalName: row.original_name,
          documentType: row.requested_document_type,
          failureCode: row.failure_code,
          previousRetryReason: row.operator_retry_reason,
          failedAt: row.failed_at,
          updatedAt: row.updated_at,
          // Kurtarma komutunun ön koşulları listede söylenir ki operatör
          // düğmeye basıp 409 okumak yerine neyin eksik olduğunu baştan görsün.
          retryable: Boolean(row.has_receipt) && Boolean(row.has_quarantine)
            && Boolean(row.failed_at) && isOperatorRetryWindowOpen(row.failed_at!, now),
        })),
      });
    }
    const principal = await authorizeRequest(request, bindings.DB, "document.upload", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    const id = url.searchParams.get("id");
    /*
     * `ids` ile istenen oturumlar hızlı kabul sihirbazının yoklamasıdır:
     * kabul edilenler de (ACCEPTED) döner ve terfinin ürettiği belge kimliği
     * eklenir — sihirbaz yüklediği dosyanın hangi belgeye dönüştüğünü ancak
     * böyle bilir. Liste yine kullanıcının KENDİ oturumlarıyla sınırlıdır.
     */
    const ids = (url.searchParams.get("ids") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (ids.length) {
      if (ids.length > 40) return jsonError("Tek istekte en fazla 40 oturum sorgulanabilir.");
      const placeholders = ids.map(() => "?").join(", ");
      const sessions = await bindings.DB.prepare(`SELECT s.id, s.original_name, s.requested_document_type,
          s.status, s.duplicate_of_document_id, s.failure_code, s.created_at, s.updated_at,
          (SELECT j.document_id FROM promotion_jobs j
            WHERE j.upload_session_id = s.id AND j.status = 'COMPLETED'
            ORDER BY j.created_at DESC LIMIT 1) AS promoted_document_id
        FROM upload_sessions s WHERE s.user_id = ? AND s.id IN (${placeholders})`)
        .bind(principal.email, ...ids)
        .all<{ id: string; original_name: string; requested_document_type: string; status: string;
          duplicate_of_document_id: string | null; failure_code: string | null;
          created_at: string; updated_at: string; promoted_document_id: string | null }>();
      return Response.json({
        sessions: sessions.results.map((row) => ({
          id: row.id,
          originalName: row.original_name,
          documentType: row.requested_document_type,
          status: row.status,
          duplicateOfDocumentId: row.duplicate_of_document_id,
          documentId: row.promoted_document_id,
          failureCode: row.failure_code,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    }
    /*
     * Kimliksiz istek, KENDİ yüklemelerinin son durumunu listeler. Belge
     * kaydı ancak tarama + terfi sonrası doğar (F1.5); o ana kadar yükleme
     * hiçbir listede görünmüyordu ve "belge karantinaya alındı" diyen memur
     * sonrasında kaybolmuş bir dosyaya bakıyordu. Mükerrer ve ret gibi
     * terminal sonuçlar da burada görünür — dosyanın NEDEN listeye
     * girmediği söylenmeden yükleme akışı dürüst sayılmaz.
     */
    if (!id) {
      const sessions = await bindings.DB.prepare(`SELECT id, original_name, requested_document_type,
          status, duplicate_of_document_id, failure_code, created_at, updated_at
        FROM upload_sessions WHERE user_id = ? AND status <> 'ACCEPTED'
        ORDER BY updated_at DESC LIMIT 20`)
        .bind(principal.email)
        .all<{ id: string; original_name: string; requested_document_type: string; status: string;
          duplicate_of_document_id: string | null; failure_code: string | null;
          created_at: string; updated_at: string }>();
      return Response.json({
        sessions: sessions.results.map((row) => ({
          id: row.id,
          originalName: row.original_name,
          documentType: row.requested_document_type,
          status: row.status,
          duplicateOfDocumentId: row.duplicate_of_document_id,
          failureCode: row.failure_code,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    }
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

