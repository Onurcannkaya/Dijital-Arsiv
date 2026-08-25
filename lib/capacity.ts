/**
 * Depolama kapasite kotası — ölçüm ve eşik alarmı.
 *
 * Kota bugüne kadar hiç tanımlı değildi ve pano bunu dürüstçe "ölçülmüyor"
 * diye bildiriyordu. Bu modülle ikiye ayrılır:
 *
 * - KULLANIM her durumda ölçülür: `binary_objects` toplam baytı. Kota fiziksel
 *   kapasitedir; müdürlük kapsam süzgeci uygulanmaz — disk dolduğunda bütün
 *   müdürlükler birden durur, doluluk oranı bu yüzden herkese aynı gösterilir.
 * - TAVAN kurum kararıdır (`ARCHIVE_STORAGE_QUOTA_GB`, İş Etki Analizine
 *   bağlanır). Tanımlı değilse kota "tanımlı değil" olarak raporlanır;
 *   uydurma bir tavan asla üretilmez.
 *
 * Eşik alarmı: %80 uyarı, %95 kritik. Aynı eşik için günde en çok bir alarm
 * gider; "bir kez"in kanıtı `capacity_alerts` defteridir — bellekte sayaç
 * tutulsaydı her süreç yeniden başlatmada alarm tekrarlanırdı.
 */

import type { ArchiveBindings } from "./archive-bindings.ts";
import { dispatchAlert } from "./alerts.ts";
import { logEvent } from "./observability.ts";

export const QUOTA_WARNING_RATIO = 0.8;
export const QUOTA_CRITICAL_RATIO = 0.95;
/** Türev/işletim payı bırakmak için yeni kabul kritik eşikte durur. */
export const QUOTA_ADMISSION_RATIO = QUOTA_CRITICAL_RATIO;

export type StorageQuota =
  | { configured: false; usedBytes: number }
  | { configured: true; usedBytes: number; limitBytes: number; usedRatio: number };

export function configuredLimitBytes(bindings: Pick<ArchiveBindings, "ARCHIVE_STORAGE_QUOTA_GB">): number | null {
  const raw = bindings.ARCHIVE_STORAGE_QUOTA_GB?.trim();
  if (!raw) return null;
  const gb = Number(raw);
  if (!Number.isFinite(gb) || gb <= 0) {
    // Bozuk yapılandırma sessizce "kota yok" sayılmaz; log'da görünür kalır.
    logEvent("error", "capacity.quota-invalid", { value: raw });
    return null;
  }
  return Math.round(gb * 1024 * 1024 * 1024);
}

export async function readStorageQuota(
  bindings: Pick<ArchiveBindings, "DB" | "ARCHIVE_STORAGE_QUOTA_GB">,
): Promise<StorageQuota> {
  const used = await bindings.DB.prepare(`SELECT
      (SELECT COALESCE(SUM(byte_size), 0) FROM binary_objects)
      + (SELECT COALESCE(SUM(byte_size), 0) FROM ingest_objects WHERE deleted_at IS NULL) AS bytes`)
    .first<{ bytes: number }>();
  const usedBytes = Number(used?.bytes ?? 0);
  const limitBytes = configuredLimitBytes(bindings);
  if (!limitBytes) return { configured: false, usedBytes };
  return { configured: true, usedBytes, limitBytes, usedRatio: usedBytes / limitBytes };
}

/** Yeni oturumların atomik SQL rezervasyonunda kullanılacak güvenli tavan. */
export function uploadAdmissionLimitBytes(
  bindings: Pick<ArchiveBindings, "ARCHIVE_STORAGE_QUOTA_GB">,
): number | null {
  const configured = configuredLimitBytes(bindings);
  return configured ? Math.floor(configured * QUOTA_ADMISSION_RATIO) : null;
}

export type QuotaCheckResult =
  | { skipped: true; reason: "unconfigured" | "below-threshold" | "already-alerted" }
  | { skipped: false; thresholdPercent: number; usedRatio: number };

/**
 * Bakım turundan çağrılır: eşik aşımını ölçer, günde bir kez alarm iletir.
 * Kritik eşik uyarı eşiğini gölgeler — %96 dolulukta iki ayrı alarm gitmez,
 * yalnız kritik gider.
 */
export async function runQuotaCheck(
  bindings: Pick<ArchiveBindings, "DB" | "ARCHIVE_STORAGE_QUOTA_GB" | "ALARM_WEBHOOK_URL" | "ALARM_WEBHOOK_TOKEN" | "APP_ENV">,
  options: { now?: Date } = {},
): Promise<QuotaCheckResult> {
  const quota = await readStorageQuota(bindings);
  if (!quota.configured) return { skipped: true, reason: "unconfigured" };

  const crossed = quota.usedRatio >= QUOTA_CRITICAL_RATIO
    ? { percent: Math.round(QUOTA_CRITICAL_RATIO * 100), severity: "critical" as const }
    : quota.usedRatio >= QUOTA_WARNING_RATIO
      ? { percent: Math.round(QUOTA_WARNING_RATIO * 100), severity: "warning" as const }
      : null;
  if (!crossed) return { skipped: true, reason: "below-threshold" };

  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  /*
   * İki taraf da datetime() ile normalleştirilir: kolon ISO ('T'li) yazılır,
   * datetime() boşluklu üretir ve ham TEXT karşılaştırmasında 'T' > ' '
   * olduğundan pencere hiç kapanmazdı (alarm sonsuza dek "bugün atıldı" kalırdı).
   */
  const recent = await bindings.DB.prepare(`SELECT 1 AS var FROM capacity_alerts
    WHERE threshold_percent = ? AND datetime(created_at) >= datetime(?, '-1 day') LIMIT 1`)
    .bind(crossed.percent, nowIso).first<{ var: number }>();
  if (recent) return { skipped: true, reason: "already-alerted" };

  await bindings.DB.prepare(`INSERT INTO capacity_alerts
      (id, threshold_percent, used_bytes, limit_bytes, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), crossed.percent, quota.usedBytes, quota.limitBytes, nowIso).run();
  const usedGb = (quota.usedBytes / 1024 / 1024 / 1024).toFixed(1);
  const limitGb = (quota.limitBytes / 1024 / 1024 / 1024).toFixed(1);
  await dispatchAlert(bindings, {
    severity: crossed.severity,
    event: "capacity.threshold",
    title: `Depolama kotasının %${Math.round(quota.usedRatio * 100)}'i doldu (${usedGb} / ${limitGb} GB); kapasite planı gözden geçirilmeli.`,
    detail: {
      usedBytes: quota.usedBytes,
      limitBytes: quota.limitBytes,
      thresholdPercent: crossed.percent,
    },
  });
  return { skipped: false, thresholdPercent: crossed.percent, usedRatio: quota.usedRatio };
}
