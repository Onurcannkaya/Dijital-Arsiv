import { prepareAuditEvent } from "../../../../lib/audit";
import { authorizeRequest } from "../../../../lib/authorization";
import { getArchiveBindings, jsonError, requireArchiveSchema } from "../../../../lib/archive-storage";
import { failure } from "../../../../lib/errors";

export const dynamic = "force-dynamic";

/** Tek istekte kuyruğa geri alınabilecek iş sayısı; toplu tıklama sınırsız iş açamaz. */
const MAX_REQUEUE = 100;

type DeadLetterRow = {
  job_id: string; document_id: string; reference_no: string; original_name: string;
  document_type: string; unit: string; attempt: number; max_attempts: number;
  error_message: string | null; dead_lettered_at: string | null;
};

/**
 * OCR dead-letter kuyruğu yönetimi.
 *
 * Pano "N iş dead-letter kuyruğunda — işletim incelemesi gerekiyor" diyordu
 * ama o işlere giden bir yol yoktu: liste yoktu, tek belge yolu için memurun
 * belgeyi bilip açması gerekiyordu. Bu uç ikisini kapatır:
 *
 * - GET: azami denemeyi tüketmiş işlerin listesi (müdürlük kapsamıyla).
 * - POST: seçilen belgelerin (ya da kapsamdaki hepsinin) işini kuyruğa geri
 *   alır. Deneme bütçesi bilinçli olarak tazelenir — operatör kararı yeni
 *   bütçe demektir (ADR-013 kurtarma komutuyla aynı ilke); son hata mesajı
 *   denetim olayına taşınır ki "neden düşmüştü" sorusu iz kaybetmesin.
 *
 * İş hemen ÇALIŞTIRILMAZ: kuyruğa dönen işi cron, sihirbaz yoklaması ya da
 * "Belgeyi okut" düğmesi alır. Burada eşzamanlı OCR başlatmak tek uçuşlu
 * Paddle'ı boğar ve toplu geri almada saatlik iş açardı.
 */
export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "ocr.run", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const rows = await bindings.DB.prepare(`SELECT j.id AS job_id, j.document_id, d.reference_no,
        d.original_name, d.document_type, d.unit, j.attempt, j.max_attempts,
        j.error_message, j.dead_lettered_at
      FROM processing_jobs j INNER JOIN archive_documents d ON d.id = j.document_id
      WHERE j.status = 'failed' AND j.attempt >= j.max_attempts
        AND (? = '*' OR d.unit = ?)
      ORDER BY j.dead_lettered_at DESC LIMIT 100`)
      .bind(principal.unit, principal.unit).all<DeadLetterRow>();

    return Response.json({
      jobs: rows.results.map((row) => ({
        jobId: row.job_id,
        documentId: row.document_id,
        referenceNo: row.reference_no,
        originalName: row.original_name,
        documentType: row.document_type,
        unit: row.unit,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        errorMessage: row.error_message,
        deadLetteredAt: row.dead_lettered_at,
      })),
    });
  } catch (error) {
    return failure(error, "jobs.dead-letter", "Dead-letter kuyruğu okunamadı.", request);
  }
}

export async function POST(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "ocr.run", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const body = await request.json().catch(() => null) as { documentIds?: unknown } | null;
    const requested = Array.isArray(body?.documentIds)
      ? body.documentIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (requested.length > MAX_REQUEUE) {
      return jsonError(`Tek istekte en fazla ${MAX_REQUEUE} belge kuyruğa geri alınabilir.`);
    }

    // Hedef küme her durumda sunucuda, kapsam süzgeciyle belirlenir; istemcinin
    // gönderdiği kimlik listesi yalnız daraltır, kapsam dışına çıkaramaz.
    const placeholders = requested.map(() => "?").join(", ");
    const rows = await bindings.DB.prepare(`SELECT j.id AS job_id, j.document_id, d.reference_no,
        j.error_message
      FROM processing_jobs j INNER JOIN archive_documents d ON d.id = j.document_id
      WHERE j.status = 'failed' AND j.attempt >= j.max_attempts
        AND (? = '*' OR d.unit = ?)
        ${requested.length ? `AND j.document_id IN (${placeholders})` : ""}
      ORDER BY j.dead_lettered_at ASC LIMIT ${MAX_REQUEUE}`)
      .bind(principal.unit, principal.unit, ...requested)
      .all<{ job_id: string; document_id: string; reference_no: string; error_message: string | null }>();

    const nowIso = new Date().toISOString();
    let requeued = 0;
    for (const row of rows.results) {
      const audit = await prepareAuditEvent(bindings.DB, {
        documentId: row.document_id,
        actor: principal.email,
        action: "ocr.requeued",
        details: {
          jobId: row.job_id,
          previousError: row.error_message,
          referenceNo: row.reference_no,
        },
      });
      await bindings.DB.batch([
        bindings.DB.prepare(`UPDATE processing_jobs SET status = 'queued', attempt = 0,
            error_message = NULL, next_attempt_at = NULL, dead_lettered_at = NULL,
            lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'failed'`).bind(nowIso, row.job_id),
        bindings.DB.prepare(`UPDATE archive_documents SET status = 'queued', updated_at = ?
          WHERE id = ? AND status = 'ocr_failed'`).bind(nowIso, row.document_id),
        audit.statement,
      ]);
      requeued += 1;
    }
    return Response.json({ requeued });
  } catch (error) {
    return failure(error, "jobs.dead-letter.requeue", "Dead-letter işleri kuyruğa geri alınamadı.", request);
  }
}
