/**
 * Mobil tarama kalite denetimi — design.md §4.4.
 *
 * Amaç memuru İYİ FOTOĞRAFA YÖNLENDİRMEK, kabulü engellemek değil: sahada tek
 * nüsha kötü ışıkta da çekilmek zorunda kalabilir ve OCR ön işleme (CLAHE)
 * zayıf taramayı kurtarmayı zaten dener. Uyarı bu yüzden altın karttır,
 * kırmızı değil; yükleme düğmesini kilitlemez (§5 "Düşük güven" deseniyle
 * aynı ton). Dil §6 kuralına uyar: ölçüm değil eylem cümlesi.
 *
 * Eşikler kaba ve bilinçli hoşgörülüdür: yanlış pozitif uyarı memuru
 * uyarıları toptan yok saymaya alıştırır.
 */

export type ScanMetrics = {
  width: number;
  height: number;
  /** 0–255 aralığında ortalama parlaklık (gri ton). */
  meanLuminance: number;
};

export type ScanWarning = { code: "LOW_RESOLUTION" | "TOO_DARK" | "TOO_BRIGHT"; message: string };

/** OCR'ın rahat okuduğu asgari uzun kenar; det modeli 1600'e ölçekler. */
const MIN_LONG_EDGE = 1200;
const DARK_MEAN = 70;
/*
 * Parlama eşiği doyma noktasına yakındır: metni seyrek, zemini bembeyaz bir
 * sayfa MEŞRU olarak ~245 ortalamaya çıkar ve uyarı almamalıdır. Ortalama
 * ancak beyaza gerçekten yapıştığında (flaş patlaması) bunun üzerine çıkar.
 */
const BRIGHT_MEAN = 248;

export function assessScanQuality(metrics: ScanMetrics): ScanWarning[] {
  const warnings: ScanWarning[] = [];
  const longEdge = Math.max(metrics.width, metrics.height);
  if (longEdge > 0 && longEdge < MIN_LONG_EDGE) {
    warnings.push({
      code: "LOW_RESOLUTION",
      message: "Fotoğraf düşük çözünürlüklü görünüyor — belgeye yaklaşıp yeniden çekin; yazılar okunaklı olmalı.",
    });
  }
  if (metrics.meanLuminance > 0 && metrics.meanLuminance < DARK_MEAN) {
    warnings.push({
      code: "TOO_DARK",
      message: "Fotoğraf karanlık görünüyor — ışığı artırıp veya gölgeden çıkıp yeniden çekin.",
    });
  }
  if (metrics.meanLuminance > BRIGHT_MEAN) {
    warnings.push({
      code: "TOO_BRIGHT",
      message: "Fotoğraf fazla parlak görünüyor — parlamayı önlemek için flaşı kapatıp yeniden çekin.",
    });
  }
  return warnings;
}
