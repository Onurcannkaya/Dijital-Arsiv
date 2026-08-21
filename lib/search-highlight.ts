/**
 * Arama vurgusu — sonuç listesinden açılan belgede aranan kelimenin YERİNİ
 * göstermek için. 160+ sayfalık ciltte "belge bulundu" demek yetmez; memur
 * kelimenin hangi sayfada, hangi cümlede geçtiğini görmelidir.
 *
 * Sunucu araması `normalizeSearch` biçimiyle eşleşir (lib/text-search.ts):
 * küçültme + diakritik düşürme + noktalama→boşluk. Ekranda duran metin ise
 * özgün hâlidir; vurgu için normalize edilmiş konumların özgün metindeki
 * karşılığı gerekir. `foldWithMap` aynı katlamayı KARAKTER HARİTASIYLA yapar:
 * katlanmış metindeki her konum, özgün metindeki kaynağını bilir.
 *
 * Bilinçli fark: `normalizeSearch`'teki mekanik OCR karışıklık düzeltmeleri
 * (`1`→`l` gibi) burada uygulanmaz — bu kurallar bağlama bakar ve haritayı
 * karmaşıklaştırır. Sonuç: taramada bozuk yazılmış bir kelime (`a1i`) sunucuda
 * eşleşir ama satır içinde işaretlenemeyebilir; sayfa eşleşmesi tam
 * `normalizeSearch` ile AYRICA denetlendiği için sayfa rozeti yine görünür,
 * yalnız satır vurgusu düşer. Yanlış vurgudansa eksik vurgu yeğdir.
 */

import { normalizeSearch } from "./text-search.ts";

export type HighlightRange = [start: number, end: number];

const TR_FOLD: Record<string, string> = { "ı": "i" };

/** Özgün metni arama biçimine katlar; her katlanmış karakter kaynağını bilir. */
export function foldWithMap(value: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    // NFKD diakritiği ayırır (ç→c+kuyruk), birleşik imler atılır; dotless ı
    // ayrışmadığı için ayrıca eşlenir. normalizeSearch ile aynı sonuç üretir.
    const folded = value[index].toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
    for (const raw of folded) {
      const character = TR_FOLD[raw] ?? raw;
      if (/[a-z0-9]/.test(character)) {
        text += character;
        map.push(index);
      } else if (text.length && !text.endsWith(" ")) {
        text += " ";
        map.push(index);
      }
    }
  }
  if (text.endsWith(" ")) { text = text.slice(0, -1); map.pop(); }
  return { text, map };
}

/** Serbest metin sorgusunu sunucunun kullandığı eşleşme parçalarına indirger. */
export function searchTokens(freeText: string): string[] {
  return normalizeSearch(freeText).split(/\s+/).filter(Boolean).slice(0, 8);
}

/** Değer, parçalardan herhangi birini içeriyor mu? (tam normalleştirmeyle) */
export function matchesAnyToken(value: string, tokens: string[]): boolean {
  if (!tokens.length || !value) return false;
  const normalized = normalizeSearch(value);
  return tokens.some((token) => normalized.includes(token));
}

/**
 * Parçaların özgün metindeki vurgulanacak aralıkları; sıralı ve birleşik.
 * Aralıklar üst üste binerse tek aralığa kaynaştırılır ki işaretleme iç içe
 * <mark> üretmesin.
 */
export function findHighlightRanges(display: string, tokens: string[]): HighlightRange[] {
  if (!tokens.length || !display) return [];
  const { text, map } = foldWithMap(display);
  const ranges: HighlightRange[] = [];
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(token, from);
      if (at === -1) break;
      ranges.push([map[at], map[at + token.length - 1] + 1]);
      from = at + 1;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: HighlightRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Uzun sayfa metninden eşleşme çevresi kırpar: memur cümleyi bağlamıyla
 * görür, 160 sayfayı kaydırmaz. En çok `limit` kırpıntı döner; her kırpıntı
 * kendi içindeki vurgu aralıklarını kırpıntıya göre taşır.
 */
export function matchSnippets(display: string, ranges: HighlightRange[], limit = 3, padding = 70):
    Array<{ text: string; ranges: HighlightRange[]; leading: boolean; trailing: boolean }> {
  const snippets: Array<{ text: string; ranges: HighlightRange[]; leading: boolean; trailing: boolean }> = [];
  let cursor = 0;
  while (cursor < ranges.length && snippets.length < limit) {
    const start = Math.max(0, ranges[cursor][0] - padding);
    // Aynı pencereye düşen ardışık eşleşmeler tek kırpıntıda toplanır.
    let last = cursor;
    while (last + 1 < ranges.length && ranges[last + 1][0] <= ranges[last][1] + padding * 2) last += 1;
    const end = Math.min(display.length, ranges[last][1] + padding);
    snippets.push({
      text: display.slice(start, end),
      ranges: ranges.slice(cursor, last + 1).map(([a, b]) => [a - start, b - start]),
      leading: start > 0,
      trailing: end < display.length,
    });
    cursor = last + 1;
  }
  return snippets;
}
