import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  createDigestStreamHasher,
  getArchiveBindings,
  getPromotionStorages,
  jsonError,
  requireArchiveSchema,
} from "../../../../../lib/archive-storage";
import { isOperatorRetryWindowOpen } from "../../../../../lib/ingest-contract";
import { prepareIngestTransition } from "../../../../../lib/ingest-events";
import { processNextPromotionJob } from "../../../../../lib/ingest-promotion";
import { failure } from "../../../../../lib/errors";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

type SessionRow = {
  id: string; status: string; unit: string; user_id: string; original_name: string;
};

/**
 * ADR-013 operatör kurtarma komutu: FAILED oturumu PROMOTING durumuna geri alır.
 *
 * Alan kuralı (`ingest-state-machine.ts`), olay zinciri (`ingest-events.ts`) ve
 * veritabanı bekçileri (`ingest-schema.ts` CHECK + trigger) baştan beri hazırdı;
 * bu rota o sözleşmenin eksik kalan çağırıcısıdır. ADR'nin üç şartı burada
 * karşılanır: AYRI yetki (`ingest.retry`), zorunlu GEREKÇE (olay zincirine ve
 * `operator_retry_reason` kolonuna yazılır) ve DENETİM OLAYI (operatör aktörlü
 * FAILED→PROMOTING olayı).
 *
 * Kanıt denetimi defter üzerinden yapılır: karantina nesnesinin `deleted_at IS
 * NULL` kaydı ve VERIFIED+CLEAN alındısı. Nesnenin fiziksel varlığı burada
 * ayrıca doğrulanmaz — terfi işçisi zaten nesneyi okuyup SHA-256'yı yeniden
 * hesaplar; nesne yoksa iş dürüstçe yeniden FAILED olur ve denetim izinde
 * nedeniyle görünür.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "ingest.retry", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    const { id } = await context.params;

    const body = await request.json().catch(() => null) as { reason?: unknown } | null;
    const reason = typeof body?.reason === "string" ? body.reason.trim().replace(/\s+/g, " ") : "";
    if (!reason) return jsonError("Kurtarma gerekçesi zorunludur; denetim izinde 'neden' sorusu boş kalamaz.");
    if (reason.length > 500) return jsonError("Kurtarma gerekçesi 500 karakteri aşamaz.");

    const session = await bindings.DB.prepare(`SELECT id, status, unit, user_id, original_name
      FROM upload_sessions WHERE id = ?`).bind(id).first<SessionRow>();
    if (!session) return jsonError("Kabul oturumu bulunamadı.", 404);
    if (!canAccessUnit(principal, session.unit)) return jsonError("Oturum müdürlük kapsamınızın dışında.", 403);
    if (session.status !== "FAILED") {
      return jsonError(`Yalnız FAILED durumundaki oturum terfiye geri alınabilir; bu oturum ${session.status} durumunda.`, 409);
    }

    // Kanıt 1 — doğrulama alındısı: tarama temiz çıkmış olmalı (ADR-013).
    const receipt = await bindings.DB.prepare(`SELECT id FROM ingest_receipts
      WHERE upload_session_id = ? AND result = 'VERIFIED' AND scanner_result = 'CLEAN'
      ORDER BY created_at DESC LIMIT 1`).bind(id).first<{ id: string }>();
    if (!receipt) {
      return jsonError("Oturumun temiz doğrulama alındısı yok; kurtarma yalnız terfi aşamasında başarısız olmuş oturumlar içindir. Dosyayı yeniden yükleyin.", 409);
    }

    // Kanıt 2 — karantina nesnesi defterde hâlâ canlı olmalı.
    const quarantine = await bindings.DB.prepare(`SELECT object_key FROM ingest_objects
      WHERE upload_session_id = ? AND object_class = 'quarantine' AND deleted_at IS NULL
      LIMIT 1`).bind(id).first<{ object_key: string }>();
    if (!quarantine) {
      return jsonError("Karantina nesnesi temizlenmiş; kurtarılacak kaynak kalmadı. Dosyayı yeniden yükleyin.", 409);
    }

    // Kanıt 3 — yeniden deneme penceresi (ADR-014: karantina 7 gün tutulur).
    const failedEvent = await bindings.DB.prepare(`SELECT created_at FROM upload_session_events
      WHERE upload_session_id = ? AND to_status = 'FAILED'
      ORDER BY event_number DESC LIMIT 1`).bind(id).first<{ created_at: string }>();
    if (!failedEvent || !isOperatorRetryWindowOpen(failedEvent.created_at, new Date())) {
      return jsonError("Yeniden deneme penceresi kapandı (karantina saklama süresi 7 gün); dosyayı yeniden yükleyin.", 409);
    }

    // Terfi işi kaydı olmadan PROMOTING oturum sahipsiz asılı kalır.
    const job = await bindings.DB.prepare(`SELECT id, sha256 FROM promotion_jobs
      WHERE upload_session_id = ? LIMIT 1`).bind(id).first<{ id: string; sha256: string }>();
    if (!job) {
      return jsonError("Oturumun terfi işi kaydı bulunamadı; oturum terfi aşamasına hiç ulaşmamış. Dosyayı yeniden yükleyin.", 409);
    }
    /*
     * `promotion_jobs_active_sha_unique`: FAILED olmayan işlerde SHA tekildir.
     * Aynı içerik başka bir oturumda hâlâ terfi ediyorsa bu işi kuyruğa geri
     * almak kısıta çarpar; beklemek de gereksizdir — kazanan oturum kasaya
     * yazınca bu oturum zaten mükerrer olarak kapanacaktır.
     */
    const activeTwin = await bindings.DB.prepare(`SELECT id FROM promotion_jobs
      WHERE sha256 = ? AND status <> 'FAILED' AND upload_session_id <> ? LIMIT 1`)
      .bind(job.sha256, id).first<{ id: string }>();
    if (activeTwin) {
      return jsonError("Aynı içerik başka bir oturumda terfi ediyor; o oturum sonuçlanınca bu kayıt mükerrer olarak kapanır.", 409);
    }

    const nowIso = new Date().toISOString();
    const transition = await prepareIngestTransition(bindings.DB, {
      sessionId: id,
      to: "PROMOTING",
      actor: { kind: "operator", id: principal.email },
      reason,
      ingestReceiptId: receipt.id,
      retryEvidence: {
        actorKind: "operator",
        actorId: principal.email,
        reason,
        quarantineObjectAvailable: true,
        verifiedReceiptAvailable: true,
        retryWindowOpen: true,
      },
      now: nowIso,
    });
    await bindings.DB.batch([
      ...transition.statements,
      // Deneme bütçesi operatör kararıyla tazelenir; sayaç sıfırlanmazsa
      // kuyruk işi `attempt >= max_attempts` nedeniyle bir daha almaz.
      bindings.DB.prepare(`UPDATE promotion_jobs SET status = 'QUEUED', attempt = 0,
        next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error = NULL, updated_at = ? WHERE id = ?`).bind(nowIso, job.id),
    ]);

    /*
     * Operatör sonucu beklemesin: bir terfi turu hemen denenir. Başarısızlık
     * kurtarmayı geri almaz — iş kuyruğa alınmıştır, cron kaldığı yerden sürer.
     */
    let promoted: unknown = null;
    if (bindings.QUARANTINE_FILES) {
      try {
        promoted = await processNextPromotionJob({
          db: bindings.DB,
          ...getPromotionStorages(bindings),
          hasher: createDigestStreamHasher(),
        });
      } catch { /* Tur ilerletilemedi; kuyruk kaydı durur, cron dener. */ }
    }

    const refreshed = await bindings.DB.prepare(`SELECT status, failure_code FROM upload_sessions WHERE id = ?`)
      .bind(id).first<{ status: string; failure_code: string | null }>();
    return Response.json({
      session: { id, status: refreshed?.status ?? "PROMOTING", failureCode: refreshed?.failure_code ?? null },
      promotionAttempted: Boolean(promoted),
    });
  } catch (error) {
    return failure(error, "uploads.retry", "Kurtarma komutu çalıştırılamadı.", request);
  }
}
