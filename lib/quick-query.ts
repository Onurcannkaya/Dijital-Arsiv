/**
 * Hızlı sorgu dili — design.md §3.10.
 *
 * Memur arama kutusuna `mahalle:Kandemir ada:32 parsel:2` yazar; anahtarlı
 * parçalar HEDEFLİ süzgece dönüşür, kalanı serbest metin aramasında kalır.
 * Serbest metin "1284" hem adada hem tam metinde eşleşir ve kalabalık sonuç
 * verir; `ada:1284` yalnız ada alanına bakar.
 *
 * Kurallar:
 * - Desteklenen anahtarlar: `mahalle: ada: parsel: tur: mudurluk: yil: ref:`.
 *   Türkçe yazımlar da kabul edilir (`tür:`, `müdürlük:`, `yıl:`) — memur
 *   klavyesinde doğal olan budur; ASCII biçim şartnamedeki kanonik addır.
 * - Çok kelimeli değer tırnakla verilir: `mahalle:"Yeni Mahalle"`.
 * - Bilinmeyen anahtar süzgeç DEĞİLDİR; parça olduğu gibi serbest metne
 *   kalır — `saat:14` yazan biri sorgusunun sessizce yutulmasını beklemez.
 * - Aynı anahtar iki kez verilirse son değer geçerlidir.
 */

export const QUICK_QUERY_KEYS = ["mahalle", "ada", "parsel", "tur", "mudurluk", "yil", "ref"] as const;
export type QuickQueryKey = (typeof QUICK_QUERY_KEYS)[number];

export type ParsedQuickQuery = {
  filters: Partial<Record<QuickQueryKey, string>>;
  /** Anahtarlı parçalar çıkarıldıktan sonra kalan serbest metin. */
  freeText: string;
};

/** Ekranda gösterilen süzgeç adları. */
export const QUICK_QUERY_LABELS: Record<QuickQueryKey, string> = {
  mahalle: "Mahalle", ada: "Ada", parsel: "Parsel", tur: "Belge türü",
  mudurluk: "Müdürlük", yil: "Yıl", ref: "Referans",
};

/** Türkçe yazımları kanonik anahtara indirger. */
const KEY_ALIASES: Record<string, QuickQueryKey> = {
  mahalle: "mahalle",
  ada: "ada",
  parsel: "parsel",
  tur: "tur", "tür": "tur",
  mudurluk: "mudurluk", "müdürlük": "mudurluk", "mudurluğu": "mudurluk",
  yil: "yil", "yıl": "yil",
  ref: "ref", referans: "ref",
};

export function parseQuickQuery(query: string): ParsedQuickQuery {
  const filters: Partial<Record<QuickQueryKey, string>> = {};
  const free: string[] = [];
  /*
   * Parçalama tırnak bilinciyle yapılır: `mahalle:"Yeni Mahalle"` tek
   * parçadır. Tırnak kapanmazsa satır sonuna kadar değer sayılır — memurun
   * yarım tırnağı sorguyu bozmamalıdır.
   */
  const tokens = query.match(/\S+:"[^"]*"?|\S+/g) ?? [];
  for (const token of tokens) {
    const separator = token.indexOf(":");
    if (separator <= 0 || separator === token.length - 1) {
      free.push(token);
      continue;
    }
    const key = KEY_ALIASES[token.slice(0, separator).toLocaleLowerCase("tr-TR")];
    if (!key) {
      free.push(token);
      continue;
    }
    const value = token.slice(separator + 1).replace(/^"|"$/g, "").trim();
    if (!value) {
      free.push(token);
      continue;
    }
    filters[key] = value;
  }
  return { filters, freeText: free.join(" ") };
}

/** Sorguda en az bir hedefli süzgeç var mı? */
export function hasQuickFilters(parsed: ParsedQuickQuery): boolean {
  return Object.keys(parsed.filters).length > 0;
}
