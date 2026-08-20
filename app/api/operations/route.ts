import { authorizeRequest } from "../../../lib/authorization";
import { getArchiveBindings, requireArchiveSchema } from "../../../lib/archive-storage";
import { failure } from "../../../lib/errors";

export const dynamic = "force-dynamic";

/**
 * İşletim ölçümleri (YOL_HARITASI_FAZLAR.md §11).
 *
 * Buradaki her sayı MEVCUT defterlerden türetilir; yeni sayaç tablosu
 * açılmaz. §11 listesinden bilinçli olarak DIŞARIDA kalanlar ve nedenleri:
 * - zararlı içerik imza yaşı: tarama servisinin kendi verisidir; uygulama
 *   uydurmaz (servis /health'i genişletilirse buraya bağlanır);
 * - bütünlük/uzlaştırma, türev ve yedek ölçümleri: /api/overview zaten
 *   ölçüyor, ikinci kopyası tutulmaz.
 *
 * Yetki `users.manage`: metrikler kurum genelidir (müdürlük süzgeci yok) ve
 * Ayarlar ekranında yaşar; belge okuma yetkisi bu genel görünümü açmaz.
 */

/** k'ıncı yüzdelik (0..1); sıralı dizide en yakın-üst eleman kuralı. */
function percentile(sorted: number[], k: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(k * sorted.length) - 1));
  return sorted[index];
}

/** ISO ('T'li) ve SQLite ('boşluklu') damgaların ikisini de UTC kabul eder. */
function parseMoment(value: string): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const time = new Date(/Z$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`).getTime();
  return Number.isNaN(time) ? null : time;
}

export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "users.manage", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    const DB = bindings.DB;

    const [sessions, parts, receipts, promotions, access, durations] = await Promise.all([
      /*
       * Oturum durumları: aktif (yüklenmekte), hatta bekleyen (karantina
       * zinciri) ve son 7 günün terminal sonuçları. Zaman damgaları iki
       * biçimde yazılabildiğinden karşılaştırma datetime() ile normalleştirilir.
       */
      DB.prepare(`SELECT
          SUM(CASE WHEN status IN ('CREATED', 'UPLOADING') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status IN ('QUARANTINED', 'SCANNING', 'VERIFIED', 'PROMOTING') THEN 1 ELSE 0 END) AS in_pipeline,
          SUM(CASE WHEN status = 'EXPIRED' AND datetime(updated_at) >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS expired_7d,
          SUM(CASE WHEN status = 'REJECTED' AND datetime(updated_at) >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS rejected_7d,
          SUM(CASE WHEN status = 'DUPLICATE' AND datetime(updated_at) >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS duplicate_7d,
          SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed_open,
          SUM(CASE WHEN status = 'ACCEPTED' AND datetime(updated_at) >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS accepted_7d
        FROM upload_sessions`).first<Record<string, number>>(),
      // Multipart sağlığı: yeniden denenen parça oranı yükleme ağının kalitesidir.
      DB.prepare(`SELECT COUNT(*) AS total,
          SUM(CASE WHEN attempt_count > 1 THEN 1 ELSE 0 END) AS retried
        FROM upload_parts p INNER JOIN upload_sessions s ON s.id = p.upload_session_id
        WHERE datetime(s.updated_at) >= datetime('now', '-7 day')`).first<Record<string, number>>(),
      // Tür uyuşmazlığı ve zararlı içerik reddi: kabul hattının K-1 kanıtı.
      DB.prepare(`SELECT
          SUM(CASE WHEN type_validation_result IN ('MISMATCH', 'UNSUPPORTED') THEN 1 ELSE 0 END) AS type_mismatch_7d,
          SUM(CASE WHEN scanner_result = 'MALICIOUS' THEN 1 ELSE 0 END) AS malware_7d,
          SUM(CASE WHEN result = 'FAILED' THEN 1 ELSE 0 END) AS scan_failed_7d
        FROM ingest_receipts
        WHERE datetime(created_at) >= datetime('now', '-7 day')`).first<Record<string, number>>(),
      // Yazma sonrası doğrulama: kasaya yazılan her bayt yeniden okunup özetlenir.
      DB.prepare(`SELECT
          SUM(CASE WHEN result = 'VERIFIED' THEN 1 ELSE 0 END) AS verified_7d,
          SUM(CASE WHEN result = 'FAILED' THEN 1 ELSE 0 END) AS failed_7d,
          SUM(CASE WHEN result = 'FAILED' AND failure_code = 'VAULT_VERIFICATION_FAILED' THEN 1 ELSE 0 END) AS vault_mismatch_7d,
          SUM(CASE WHEN result = 'FAILED' AND failure_code = 'KEY_ALREADY_EXISTS' THEN 1 ELSE 0 END) AS write_conflict_7d
        FROM promotion_receipts
        WHERE datetime(created_at) >= datetime('now', '-7 day')`).first<Record<string, number>>(),
      // Erişim: bilet reddi yetkisiz asıl erişim denemesinin görünür ucudur.
      DB.prepare(`SELECT
          SUM(CASE WHEN action = 'document.access-denied' AND datetime(created_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS denied_24h,
          SUM(CASE WHEN action = 'document.access-denied' AND datetime(created_at) >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS denied_7d,
          SUM(CASE WHEN action = 'document.ticket-issued' AND datetime(created_at) >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS tickets_7d
        FROM audit_events
        WHERE action IN ('document.access-denied', 'document.ticket-issued')`).first<Record<string, number>>(),
      /*
       * Kabul süresi ve dosya boyutu: son 7 günde ACCEPTED olan oturumlar.
       * Süre, oturumun açılışından ACCEPTED olayına kadardır; yüzdelikler
       * uygulama tarafında hesaplanır (SQLite'ta yüzdelik yok) ve küme 500
       * oturumla sınırlanır — pilot ölçeğinde tamamı demektir.
       */
      DB.prepare(`SELECT s.created_at AS opened_at, e.created_at AS accepted_at, s.expected_byte_size
        FROM upload_sessions s
        INNER JOIN upload_session_events e ON e.upload_session_id = s.id AND e.to_status = 'ACCEPTED'
        WHERE s.status = 'ACCEPTED' AND datetime(e.created_at) >= datetime('now', '-7 day')
        ORDER BY e.created_at DESC LIMIT 500`)
        .all<{ opened_at: string; accepted_at: string; expected_byte_size: number }>(),
    ]);

    const count = (row: Record<string, number> | null, key: string) => Number(row?.[key] ?? 0);
    const durationSeconds = durations.results
      .map((row) => {
        const opened = parseMoment(row.opened_at);
        const accepted = parseMoment(row.accepted_at);
        return opened !== null && accepted !== null && accepted >= opened
          ? Math.round((accepted - opened) / 1000) : null;
      })
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right);
    const byteSizes = durations.results
      .map((row) => Number(row.expected_byte_size))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);

    const partsTotal = count(parts, "total");
    const partsRetried = count(parts, "retried");
    return Response.json({
      sessions: {
        active: count(sessions, "active"),
        inPipeline: count(sessions, "in_pipeline"),
        accepted7d: count(sessions, "accepted_7d"),
        expired7d: count(sessions, "expired_7d"),
        rejected7d: count(sessions, "rejected_7d"),
        duplicate7d: count(sessions, "duplicate_7d"),
        failedOpen: count(sessions, "failed_open"),
      },
      multipart: {
        parts7d: partsTotal,
        retriedParts7d: partsRetried,
        retryRate7d: partsTotal > 0 ? partsRetried / partsTotal : 0,
      },
      contentScan: {
        typeMismatch7d: count(receipts, "type_mismatch_7d"),
        malware7d: count(receipts, "malware_7d"),
        scanFailed7d: count(receipts, "scan_failed_7d"),
      },
      promotion: {
        verified7d: count(promotions, "verified_7d"),
        failed7d: count(promotions, "failed_7d"),
        vaultMismatch7d: count(promotions, "vault_mismatch_7d"),
        writeConflict7d: count(promotions, "write_conflict_7d"),
      },
      access: {
        denied24h: count(access, "denied_24h"),
        denied7d: count(access, "denied_7d"),
        ticketsIssued7d: count(access, "tickets_7d"),
      },
      intake: {
        sampled7d: durationSeconds.length,
        durationP50Seconds: percentile(durationSeconds, 0.5),
        durationP95Seconds: percentile(durationSeconds, 0.95),
        byteSizeP50: percentile(byteSizes, 0.5),
        byteSizeP95: percentile(byteSizes, 0.95),
      },
    });
  } catch (error) {
    return failure(error, "operations.read", "İşletim ölçümleri alınamadı.", request);
  }
}
