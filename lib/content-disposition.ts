type Disposition = "attachment" | "inline";

const ATTR_CHAR = /^[A-Za-z0-9!#$&+.^_`|~-]$/;

function percentEncodeUtf8(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => {
    const character = String.fromCharCode(byte);
    return ATTR_CHAR.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

/**
 * HTTP başlığında hem eski istemciler için ASCII ad hem RFC 5987 UTF-8 ad
 * üretir. Ham kullanıcı adı hiçbir zaman CR/LF, tırnak veya ters eğik çizgi
 * olarak başlığa giremez.
 */
export function contentDisposition(disposition: Disposition, fileName: string): string {
  const cleaned = Array.from(fileName.replace(/[\u0000-\u001f\u007f"\\/]/g, "_"))
    .slice(0, 180)
    .join("") || "document";
  const asciiFallback = cleaned
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim() || "document";

  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${percentEncodeUtf8(cleaned)}`;
}
