/**
 * Makine güveninin personel diline çevrilmesi.
 *
 * design.md ilke 4: *"Güven, sayı değil eylemdir. Personele `%41` gösterilmez;
 * 'belgede elle yazılmış, bilgisayar emin değil, kontrol edin' gösterilir.
 * Yüzdeler yalnızca yönetici/denetim ekranlarında ve API'de kalır."*
 *
 * Gerekçe: `%66` bir memura ne yapması gerektiğini söylemez. İki farklı kişi
 * aynı sayıdan farklı sonuç çıkarır ve eşik nerededir bilinmez. Oysa karar
 * ikili: bu değeri belgeyle karşılaştırmam gerekiyor mu, gerekmiyor mu.
 * Sayının kendisi ölçüm olarak değerlidir ve API'de, denetim izinde ve
 * yönetici düzenlerinde (design.md §4.3) durmaya devam eder — yalnız personel
 * arayüzünde eyleme çevrilir.
 *
 * Eşikler `lib/field-policy.ts` içindeki risk hesabıyla aynı yerlerden geçer
 * (0.75 ve 0.90) ki ekranın söylediğiyle sistemin hesapladığı ayrışmasın.
 */

/** Personelin okuduğu tek cümlelik eylem ifadesi. */
export function confidencePhrase(confidence: number, origin: "OCR" | "HUMAN"): string {
  if (origin === "HUMAN") return "personel girişi";
  if (confidence >= 0.9) return "bilgisayar net okudu";
  if (confidence >= 0.75) return "bilgisayar emin değil — belgeyle karşılaştırın";
  return "bilgisayar bu yazıdan emin değil — belgedeki değeri kontrol edin";
}

/**
 * Liste sütunu gibi dar alanlar için kısa karşılık.
 *
 * Aynı eşikleri kullanır; tam cümle sığmayan yerde de personel aynı kararı
 * okumalıdır.
 */
export function confidenceBadge(confidence: number): { label: string; needsReview: boolean } {
  if (confidence >= 0.9) return { label: "Net okundu", needsReview: false };
  if (confidence >= 0.75) return { label: "Gözden geçirin", needsReview: true };
  return { label: "Kontrol edin", needsReview: true };
}

/**
 * Teknik görünümün ham yüzde biçimi — design.md §9.3 kararı (2026-08-13).
 *
 * Yüzde yalnız `technical.view` yetkisi olan kullanıcının AÇTIĞI teknik
 * görünümde belirir; personel dili varsayılan kalır. Biçimleme burada, ortak
 * çeviri modülünde durur: yüzeyler güveni kendi başına sayıya çevirmez ve
 * "personel arayüzü güven yüzdesi biçimlemez" güvencesi anlamını korur.
 * Türkçe sayı biçimi kullanılır (§7): `%98,9`.
 */
export function technicalConfidence(confidence: number): string {
  return `%${(confidence * 100).toFixed(1).replace(".", ",")}`;
}
