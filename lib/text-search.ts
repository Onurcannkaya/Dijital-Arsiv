export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function normalizeSearch(value: string) {
  return value.toLocaleLowerCase("tr-TR").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replaceAll("ı", "i").replaceAll("ş", "s").replaceAll("ğ", "g").replaceAll("ç", "c").replaceAll("ö", "o").replaceAll("ü", "u")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
