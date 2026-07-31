/**
 * F1.8 — Nesne anahtarı ve custom metadata sınıflandırması.
 *
 * `LIKE '%.%'` yalnız kaba göstergeydi; türev bölüm dosyaları (`part-0001.pdf`)
 * gibi politika uyumlu anahtarları da sayıyordu. Bu modül anahtarları yapısal
 * olarak sınıflandırır ve HAM ANAHTARI ASLA log'a/kanıta yazmaz: rapor edilen
 * biçim `maskObjectKey` çıktısıdır (harf→a, rakam→9; yapı korunur, veri gitmez).
 */

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_SEGMENT = /^[0-9a-f-]{8,64}$/i;
const DERIVATIVE_PART = /^part-\d{1,6}\.pdf$/;
const DERIVED_CLASSES = new Set(["access", "ocr", "preservation", "thumbnail"]);

/** Kabul hattının metadata sözleşmesindeki bilinen alan adları. */
export const SAFE_METADATA_FIELDS = new Set([
  "sha256", "documentId", "binaryObjectId", "objectClass", "uploadSessionId",
]);

export type KeyClassification = {
  legacy: boolean;
  /** Maskelenmiş anahtar biçimi; özgün ad/kişisel veri içermez. */
  maskedPattern: string;
  /** Maskelenmiş, makine-okur göstergeler (ör. FILENAME_EXTENSION). */
  indicators: string[];
};

export function maskObjectKey(key: string): string {
  return key.replace(/[A-ZÇĞİÖŞÜ]/g, "A").replace(/[a-zçğıöşü]/g, "a").replace(/[0-9]/g, "9");
}

function opaque(segment: string) {
  return UUID_SEGMENT.test(segment) || OPAQUE_SEGMENT.test(segment);
}

/** Politika uyumlu anahtar biçimleri; bunların dışındaki her anahtar eskidir. */
function matchesSafeShape(key: string, objectClass: string): boolean {
  const segments = key.split("/");
  if (objectClass === "original") {
    return segments.length === 3 && segments[0] === "originals"
      && opaque(segments[1]) && opaque(segments[2]);
  }
  if (DERIVED_CLASSES.has(objectClass)) {
    if (segments[0] !== "derivatives" || !opaque(segments[1])) return false;
    // OCR türevi: derivatives/<doc>/access/<obj>; render bölümü ek kuşak
    // dizini ve part-NNNN.pdf taşır.
    if (segments.length === 4) return DERIVED_CLASSES.has(segments[2]) && opaque(segments[3]);
    if (segments.length === 5) {
      return DERIVED_CLASSES.has(segments[2]) && opaque(segments[3]) && DERIVATIVE_PART.test(segments[4]);
    }
    return false;
  }
  return false;
}

function collectIndicators(key: string): string[] {
  const indicators = new Set<string>();
  if (/\s/.test(key)) indicators.add("WHITESPACE");
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(key)) indicators.add("NON_ASCII");
  const lastSegment = key.split("/").at(-1) ?? "";
  if (/\.[a-z0-9]{1,5}$/i.test(lastSegment) && !DERIVATIVE_PART.test(lastSegment)) {
    indicators.add("FILENAME_EXTENSION");
  }
  if (/(?<!\d)\d{11}(?!\d)/.test(key)) indicators.add("ELEVEN_DIGIT_RUN");
  if (/[A-ZÇĞİÖŞÜ][a-zçğıöşü]+/.test(key)) indicators.add("NAME_LIKE_CASING");
  return [...indicators].sort();
}

export function classifyObjectKey(key: string, objectClass: string): KeyClassification {
  const legacy = !matchesSafeShape(key, objectClass);
  return {
    legacy,
    maskedPattern: maskObjectKey(key),
    indicators: legacy ? collectIndicators(key) : [],
  };
}

/** Bilinmeyen metadata alan ADLARINI döndürür; değerler asla okunup raporlanmaz. */
export function classifyMetadataFields(customMetadata: Record<string, string> | undefined): string[] {
  if (!customMetadata) return [];
  return Object.keys(customMetadata).filter((field) => !SAFE_METADATA_FIELDS.has(field)).sort();
}

/** Sınıfa uygun, kişisel veri taşımayan güvenli hedef anahtar üretir. */
export function secureTargetKey(objectClass: string, documentId: string, binaryObjectId: string): string {
  return objectClass === "original"
    ? `originals/${documentId}/${binaryObjectId}`
    : `derivatives/${documentId}/${objectClass}/${binaryObjectId}`;
}
