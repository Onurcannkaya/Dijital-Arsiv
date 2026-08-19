import { authorizeRequest } from "../../../../lib/authorization";
import {
  createDigestStreamHasher,
  getArchiveBindings,
  getPromotionStorages,
  requireArchiveSchema,
} from "../../../../lib/archive-storage";
import { processNextContentScanJob } from "../../../../lib/content-scan";
import { processNextPromotionJob } from "../../../../lib/ingest-promotion";
import { processNextOcrJob } from "../../jobs/process/route";
import { failure } from "../../../../lib/errors";

export const dynamic = "force-dynamic";

/**
 * Kabul hattını yükleme yetkisiyle bir adım ilerletir.
 *
 * Tarama, terfi ve OCR normalde cron ile döner; memur belgeyi yükledikten
 * sonra sonucu dakikalarca bekler. Bu uç, hızlı kabul sihirbazının yoklama
 * döngüsünden çağrılır ve turu beklemeden SINIRLI bir dilim işler. Dilim
 * küçük tutulur (2 tarama + 2 terfi + 1 OCR): birden çok memur aynı anda
 * yüklese de her istek bağımsız küçük iş yapar; kuyruk tabloları işi atomik
 * kapattığı için aynı iş iki kez işlenmez. `/api/admin/scan`dan farkı yetki
 * eşiğidir: burada `users.manage` değil `document.upload` yeter, çünkü
 * ilerletilen şey memurun kendi beklediği hattır.
 */
export async function POST(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "document.upload", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const advanced = { contentScans: 0, promotions: 0, ocr: 0 };

    if (bindings.CONTENT_SCAN_SERVICE_URL && bindings.CONTENT_SCAN_SERVICE_TOKEN) {
      for (let index = 0; index < 2; index += 1) {
        const result = await processNextContentScanJob({
          db: bindings.DB,
          serviceUrl: bindings.CONTENT_SCAN_SERVICE_URL,
          serviceToken: bindings.CONTENT_SCAN_SERVICE_TOKEN,
        });
        if (!result.processed) break;
        advanced.contentScans += 1;
      }
    }

    if (bindings.QUARANTINE_FILES) {
      const storages = getPromotionStorages(bindings);
      for (let index = 0; index < 2; index += 1) {
        const result = await processNextPromotionJob({
          db: bindings.DB,
          ...storages,
          hasher: createDigestStreamHasher(),
        });
        if (!result.processed) break;
        advanced.promotions += 1;
      }
    }

    if (bindings.OCR_SERVICE_URL) {
      /*
       * OCR servisi tek uçuşludur (Paddle öngörücüsü iş parçacığı güvenli
       * değildir); süren bir iş varken ikinci istek servis kilidinde bekler ve
       * istek bütçesini boşa tüketir. Kontrol ile kapma atomik değildir ama
       * amaç kesin kilit değil yığılmayı sınırlamaktır — yarışta kaçan tekil
       * istek servisin kendi 409/tek-uçuş korumasına çarpar.
       */
      const inFlight = await bindings.DB.prepare(
        `SELECT COUNT(*) AS n FROM processing_jobs WHERE status = 'processing'`,
      ).first<{ n: number }>();
      if (!Number(inFlight?.n ?? 0)) {
        /*
         * Genel kuyruk EN ESKİ işi seçer (created_at ASC); toplu aktarım
         * döneminde başta binlerce sayfalık ciltler durur ve memurun az önce
         * yüklediği belge onların arkasında açlığa düşer. Sihirbazın turu bu
         * yüzden kuyruğun başını değil, çağıran memurun KENDİ en yeni bekleyen
         * belgesini hedefler; ciltleri cron kendi hızında öğütmeye devam eder.
         */
        const own = await bindings.DB.prepare(`SELECT j.document_id AS id
          FROM processing_jobs j
          INNER JOIN archive_documents d ON d.id = j.document_id
          WHERE j.status = 'queued' AND j.attempt < j.max_attempts
            AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= CURRENT_TIMESTAMP)
            AND d.uploaded_by = ?
          ORDER BY j.created_at DESC LIMIT 1`)
          .bind(principal.email).first<{ id: string }>();
        if (own) {
          /*
           * `processNextOcrJob` işi kuyruğa geri bıraktıktan sonra hatayı
           * YENİDEN FIRLATIR (jobs/process bunu yanıt gövdesine çevirir).
           * Burada yutulur: OCR denemesinin başarısızlığı turun tamamını 500
           * yapamaz — tarama/terfi sayaçları yazılmıştır, iş sayaç ve hata
           * iziyle kuyruktadır, sonraki yoklama ya da cron kaldığı yerden sürer.
           */
          try {
            const result = await processNextOcrJob(bindings, {
              actor: `user:${principal.email}`,
              unit: principal.unit,
              serviceUrl: bindings.OCR_SERVICE_URL,
              requestedDocumentId: own.id,
            });
            if (result.processed) advanced.ocr = 1;
          } catch { /* Neden processing_jobs.error_message içinde. */ }
        }
      }
    }

    return Response.json({ advanced });
  } catch (error) {
    return failure(error, "pipeline.advance", "Kabul hattı ilerletilemedi.", request);
  }
}
