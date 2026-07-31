import { authorizeRequest } from "../../../lib/authorization";
import {
  readDerivativeSummary, readIntegrityProgress, readIntegritySummary,
  readMaintenanceProgress, readReconciliationSummary, requireArchiveSchema,
  getArchiveBindings,
} from "../../../lib/archive-storage";
import { failure } from "../../../lib/errors";

export const dynamic = "force-dynamic";

/**
 * Genel bakış sayıları — tümü gerçek sorgudan gelir.
 *
 * Bu uç nokta, arayüzdeki sabit gösterge değerlerinin yerini alır. Bir kayıt
 * yönetim sisteminde uydurma sayı göstermek, kurum kullanıcısının gerçek kayıtla
 * örnek veriyi ayırt edememesine yol açar.
 *
 * Sayımlar kullanıcının müdürlük kapsamına göre süzülür: kapsam dışı belge
 * sayıya da girmez (ANA_SISTEM_TASARIM_BELGESI.md §11 — sonuç sayısı üzerinden
 * bilgi sızdırılmaz).
 */
export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    const scope = principal.unit;

    const [documents, jobs, pending, storage] = await Promise.all([
      bindings.DB.prepare(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) AS today,
          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review,
          SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
          SUM(CASE WHEN status = 'archived' AND date(updated_at) = date('now') THEN 1 ELSE 0 END) AS archived_today,
          SUM(CASE WHEN status = 'ocr_failed' THEN 1 ELSE 0 END) AS failed
        FROM archive_documents WHERE (? = '*' OR unit = ?)`).bind(scope, scope).first<Record<string, number>>(),
      bindings.DB.prepare(`SELECT
          SUM(CASE WHEN j.status = 'queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN j.status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN j.status = 'queued' AND j.next_attempt_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END) AS retry_wait,
          SUM(CASE WHEN j.status = 'failed' AND j.attempt >= j.max_attempts THEN 1 ELSE 0 END) AS dead_letter,
          SUM(CASE WHEN j.status = 'completed' AND j.updated_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS completed_24h,
          SUM(CASE WHEN j.status = 'failed' AND j.updated_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS failed_24h
        FROM processing_jobs j INNER JOIN archive_documents d ON d.id = j.document_id
        WHERE (? = '*' OR d.unit = ?)`).bind(scope, scope).first<Record<string, number>>(),
      bindings.DB.prepare(`SELECT
          (SELECT COUNT(*) FROM extracted_fields f INNER JOIN archive_documents d ON d.id = f.document_id
            WHERE f.verification_status = 'SUGGESTED' AND (? = '*' OR d.unit = ?)) AS values_pending,
          (SELECT COUNT(*) FROM document_entity_relations r INNER JOIN archive_documents d ON d.id = r.document_id
            WHERE r.verification_status = 'SUGGESTED' AND (? = '*' OR d.unit = ?)) AS relations_pending,
          (SELECT COUNT(*) FROM ocr_pages p INNER JOIN archive_documents d ON d.id = p.document_id
            WHERE p.confirmed_text IS NULL AND (? = '*' OR d.unit = ?)) AS pages_pending`)
        .bind(scope, scope, scope, scope, scope, scope).first<Record<string, number>>(),
      bindings.DB.prepare(`SELECT COUNT(*) AS objects, COALESCE(SUM(o.byte_size), 0) AS bytes,
          -- Politika öncesi yazılmış anahtarlar dosya adı taşır
          -- (S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §6). Asıl nesne
          -- değiştirilemediği için bunlar yalnız yetkili yeniden kabul ile
          -- taşınabilir; sayı görünür kalsın diye raporlanır.
          SUM(CASE WHEN o.object_key LIKE '%.%' THEN 1 ELSE 0 END) AS legacy_keys,
          -- Erişim türevi olmayan belgelerde görüntüleme asılı sunmak zorunda
          -- kalır; sayı görünür kalsın diye raporlanır.
          (SELECT COUNT(*) FROM archive_documents ad WHERE (? = '*' OR ad.unit = ?)
            AND NOT EXISTS (SELECT 1 FROM binary_objects b WHERE b.document_id = ad.id AND b.object_class = 'access')) AS without_access
        FROM binary_objects o INNER JOIN archive_documents d ON d.id = o.document_id
        WHERE (? = '*' OR d.unit = ?)`).bind(scope, scope, scope, scope).first<Record<string, number>>(),
    ]);

    const count = (row: Record<string, number> | null, key: string) => Number(row?.[key] ?? 0);
    const completed24h = count(jobs, "completed_24h");
    const failed24h = count(jobs, "failed_24h");
    return Response.json({
      scope,
      documents: {
        total: count(documents, "total"),
        today: count(documents, "today"),
        queued: count(documents, "queued"),
        processing: count(documents, "processing"),
        review: count(documents, "review"),
        ready: count(documents, "ready"),
        archived: count(documents, "archived"),
        archivedToday: count(documents, "archived_today"),
        failed: count(documents, "failed"),
      },
      jobs: {
        queued: count(jobs, "queued"),
        processing: count(jobs, "processing"),
        failed: count(jobs, "failed"),
        retryWait: count(jobs, "retry_wait"),
        deadLetter: count(jobs, "dead_letter"),
        completed24h,
        failed24h,
        errorRate24h: completed24h + failed24h > 0 ? failed24h / (completed24h + failed24h) : 0,
      },
      pending: {
        fieldValues: count(pending, "values_pending"),
        relations: count(pending, "relations_pending"),
        textPages: count(pending, "pages_pending"),
      },
      storage: {
        objects: count(storage, "objects"),
        bytes: count(storage, "bytes"),
        /** Dosya adı içeren eski nesne anahtarı sayısı; yetkili taşıma gerektirir. */
        legacyKeys: count(storage, "legacy_keys"),
        /** Erişim türevi olmayan belge sayısı; görüntülemede asıl sunulur. */
        withoutAccessDerivative: count(storage, "without_access"),
      },
      // Bekleyen bakım işi (arama dizini yenilemesi) görünür kalır: yarım kalmış
      // bir yenileme aramayı sessizce eksik bırakır.
      maintenance: await readMaintenanceProgress(bindings.DB),
      integrity: await readIntegrityProgress(bindings.DB),
      // F1.6: bulgular kalıcıdır; sayılar `integrity_findings` ve
      // `reconciliation_findings` tablolarından gelir, dilim log'undan değil.
      integrityFindings: await readIntegritySummary(bindings.DB),
      reconciliation: await readReconciliationSummary(bindings.DB),
      // F1.7: PDF erişim türevi kuyruğu; REVIEW_REQUIRED işletim metriğidir (ADR-015).
      derivatives: await readDerivativeSummary(bindings.DB),
      // Kapasite kotası, yedekleme durumu ve servis sağlığı henüz ölçülmüyor;
      // uydurma değer döndürmek yerine açıkça bildirilmez.
      unmeasured: ["storageQuota", "lastBackup", "serviceHealth"],
    });
  } catch (error) {
    return failure(error, "overview.read", "Genel bakış alınamadı.", request);
  }
}
