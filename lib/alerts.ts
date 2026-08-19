/**
 * Alarm taşıyıcısı — kritik işletim olaylarını yapılandırılmış bir uca iletir.
 *
 * Bugüne kadar bütünlük bulgusu, dead-letter birikmesi ve yedek arızası yalnız
 * yapılandırılmış log'a düşüyordu; biri panoya bakana kadar KİMSE haberdar
 * olmuyordu. Bu modül log'un yerine geçmez, üstüne haber verir:
 *
 * - `ALARM_WEBHOOK_URL` tanımlıysa olay JSON olarak POST edilir (kurumun
 *   Teams/Slack köprüsü, e-posta geçidi ya da basit bir alarm toplayıcısı —
 *   uç kurumundur, biçim sabittir).
 * - Tanımlı değilse olay `alert.unrouted` olarak loglanır; alarmın bir kanala
 *   BAĞLI OLMADIĞI gerçeği gizlenmez.
 * - Taşıyıcının kendi arızası da loglanır; alarm gönderimi hiçbir işletim
 *   işini düşürmez (en kötü durumda davranış bugünkü gibidir: yalnız log).
 *
 * Bilinçli sınır: taşıyıcı tekrar bastırma/birleştirme yapmaz. Çağıran,
 * olayı ANLAMLI anda üretmekle yükümlüdür (ör. sayaç artışında, her turda
 * değil). Alarm yönetimi (nöbet, eskalasyon) kurumun alarm sistemine aittir.
 */

import type { ArchiveBindings } from "./archive-bindings.ts";
import { logEvent } from "./observability.ts";

export type ArchiveAlert = {
  severity: "critical" | "warning";
  /** Makine tarafı olay adı (ör. "integrity.finding", "ocr.dead-letter"). */
  event: string;
  /** İnsan tarafı tek cümle; memur/işletim dili. */
  title: string;
  detail?: Record<string, unknown>;
  correlationId?: string;
};

/**
 * Alarmı iletir; asla fırlatmaz. Dönüş değeri teşhis içindir:
 * "delivered" | "unrouted" | "failed".
 */
export async function dispatchAlert(
  bindings: Pick<ArchiveBindings, "ALARM_WEBHOOK_URL" | "ALARM_WEBHOOK_TOKEN" | "APP_ENV">,
  alert: ArchiveAlert,
): Promise<"delivered" | "unrouted" | "failed"> {
  const payload = {
    source: "sivas-dijital-arsiv",
    environment: bindings.APP_ENV ?? "unknown",
    severity: alert.severity,
    event: alert.event,
    title: alert.title,
    detail: alert.detail ?? {},
    correlationId: alert.correlationId ?? null,
    timestamp: new Date().toISOString(),
  };
  if (!bindings.ALARM_WEBHOOK_URL) {
    logEvent("warn", "alert.unrouted", { event: alert.event, severity: alert.severity, title: alert.title });
    return "unrouted";
  }
  try {
    const headers: HeadersInit = { "content-type": "application/json" };
    if (bindings.ALARM_WEBHOOK_TOKEN) headers.authorization = `Bearer ${bindings.ALARM_WEBHOOK_TOKEN}`;
    const response = await fetch(bindings.ALARM_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Alarm ucu ${response.status} döndü.`);
    logEvent("info", "alert.delivered", { event: alert.event, severity: alert.severity });
    return "delivered";
  } catch (error) {
    // Alarm kaybı sessiz kalamaz; ama işletim işini de düşüremez.
    logEvent("error", "alert.delivery-failed", {
      event: alert.event,
      severity: alert.severity,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}
