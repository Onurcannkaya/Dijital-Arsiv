export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Aranabilir metin biçimi — tek uygulama.
 *
 * Daha önce aynı kural iki yerde vardı: sorgular bu dosyayla, `search_text`
 * kolonu ise OCR servisindeki Python karşılığıyla normalize ediliyordu. İki
 * uygulama farklıydı (Python'da OCR karışıklık düzeltmeleri vardı, burada
 * yoktu), bu yüzden dizin ile sorgu farklı biçimler üretip eşleşmeleri sessizce
 * kaçırabiliyordu. Artık dizin de bu fonksiyonla üretilir; Python tarafında
 * arama normalleştirmesi yoktur.
 *
 * Locale bağımsız küçültme kullanılır: `"İ"` NFKD ile `"i"`ye iner, `"I"` zaten
 * `"i"` olur. Türkçe locale kullanmak `"I"` → `"ı"` dönüşümüne yol açar ve
 * gereksiz bir belirsizlik ekler.
 */
export function normalizeSearch(value: string) {
  let text = value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  text = text
    .replaceAll("ı", "i").replaceAll("ş", "s").replaceAll("ğ", "g")
    .replaceAll("ç", "c").replaceAll("ö", "o").replaceAll("ü", "u");
  // Eski ve soluk taramalarda sık görülen mekanik OCR karışıklıkları. Kural
  // yalnız harf bağlamında uygulanır; sayısal değerler (ada, parsel, tarih)
  // bozulmaz.
  text = text.replace(/(?<=[a-z])i11\b/g, "ili");
  text = text.replace(/(?<=[a-z])1\b/g, "l");
  text = text.replace(/(?<=[a-z])[1|](?=[a-z])/g, "i");
  text = text.replace(/(?<=[a-z])0(?=[a-z])/g, "o");
  return text.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
