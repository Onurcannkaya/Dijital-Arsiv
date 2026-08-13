/**
 * Kanıt kırpması — design.md §3.3 / §9.1 kararı.
 *
 * Karar: kırpma AYRI BİR GÖRSEL ÜRETMEZ; mevcut güvenli görüntüleme
 * türevinden CSS `background-position` + `background-size` ile anlık kırpılır.
 * Ek depolama ve üretim hattı istemez, WORM kasasına yeni nesne sokmaz ve
 * kanıt her zaman personelin zaten gördüğü türevin kendisidir — ayrı bir
 * küçük görselin türevden sapması diye bir risk yoktur.
 *
 * Bütün hesap ORAN uzayında yapılır: kutu koordinatları OCR sayfa piksel
 * uzayında gelir, yüzdeye çevrilir. Görüntüleme türevi aslın tekdüze
 * ölçeklenmiş kopyası olduğundan yüzdeler her boyutta hizalı kalır
 * (design.md §8: "belge genişliği değişince kayma olmaz").
 */

export type EvidenceBox = readonly [number, number, number, number];

export type EvidenceCropStyle = {
  /** Kırpma penceresinin en-boy oranı; öğe bu oranla çizilir, bozulma olmaz. */
  aspectRatio: string;
  backgroundSize: string;
  backgroundPosition: string;
};

/** Pencere kenarlarına eklenen bağlam payı (kutu boyutunun oranı). */
const CONTEXT_PADDING = 0.35;

/**
 * Kutu çevresinde, verilen en-boy oranında bir kırpma penceresi kurar ve onu
 * CSS yüzde konumlandırmasına çevirir. Kanıtı olmayan (sıfır) kutuda `null`
 * döner — kanıtı gösterilemeyen değer kırpma da göstermez (ilke 3).
 *
 * @param box    [x0, y0, x1, y1] — OCR sayfa piksel uzayında.
 * @param pageWidth/pageHeight — OCR sayfasının piksel boyutları.
 * @param aspect Pencerenin en/boy oranı; görev kartındaki 66px şerit için ~6.
 */
export function evidenceCropStyle(
  box: EvidenceBox, pageWidth: number, pageHeight: number, aspect = 6,
): EvidenceCropStyle | null {
  const [x0, y0, x1, y1] = box;
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;
  if (!(x1 > x0) || !(y1 > y0)) return null;

  // Bağlam payıyla genişletilmiş kutu.
  const padX = (x1 - x0) * CONTEXT_PADDING;
  const padY = (y1 - y0) * CONTEXT_PADDING;
  let width = x1 - x0 + padX * 2;
  let height = y1 - y0 + padY * 2;

  // Pencereyi istenen orana getir: dar olan ekseni büyüt, asla küçültme —
  // kutunun kendisi her zaman pencerenin içinde kalır.
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;

  // Sayfadan büyük pencere sayfaya kırpılır; oran hafif bozulur ama kanıt
  // kutusu yine tam görünür (küçük sayfalarda tek seçenek budur).
  width = Math.min(width, pageWidth);
  height = Math.min(height, pageHeight);

  // Pencere sol-üst köşesi: kutuyu ortala, sayfa sınırına sıkıştır.
  const left = clamp((x0 + x1) / 2 - width / 2, 0, pageWidth - width);
  const top = clamp((y0 + y1) / 2 - height / 2, 0, pageHeight - height);

  /*
   * CSS yüzde konumlandırması: `background-position: P%` gösterilen alanla
   * görüntü arasındaki farkın P'sini kaydırır. Pencere görüntünün tamamını
   * kapsıyorsa payda sıfırlanır; o eksende kaydırma anlamsızdır, 0 kullanılır.
   */
  const posX = pageWidth - width > 0 ? (left / (pageWidth - width)) * 100 : 0;
  const posY = pageHeight - height > 0 ? (top / (pageHeight - height)) * 100 : 0;

  return {
    aspectRatio: `${round(width)} / ${round(height)}`,
    backgroundSize: `${round((pageWidth / width) * 100)}% ${round((pageHeight / height) * 100)}%`,
    backgroundPosition: `${round(posX)}% ${round(posY)}%`,
  };
}

/** Kanıt kutusu gerçek bir konum mu taşıyor? (Tümü sıfır = kanıt yok.) */
export function hasEvidenceBox(box: EvidenceBox): boolean {
  return box.some((value) => value > 0);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
