/**
 * F1.8 — Nesne anahtarı ve custom metadata sınıflandırması.
 *
 * Ham anahtar/metadata değerleri yalnız bellekte sınıflandırılır; log, denetim
 * ve taşıma kanıtına yalnız sabit bulgu kodları ile Unicode-güvenli maskeler
 * yazılır. Hedef anahtarlar kaynak kimliklerden türetilmez.
 */

const UUID_V4_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_TOKEN_SEGMENT = /^(?=[0-9a-f]{32,64}$)(?=.*[a-f])[0-9a-f]+$/i;
const DERIVATIVE_PART = /^part-\d{4}\.pdf$/;
const DERIVED_CLASSES = new Set(["access", "ocr", "preservation", "thumbnail"]);
const ALL_MIGRATABLE_CLASSES = new Set(["original", ...DERIVED_CLASSES]);
const SAFE_OBJECT_CLASSES = new Set([
  "original", "access", "ocr", "preservation", "thumbnail", "temporary", "quarantine",
]);

/** Alan adları sağlayıcı tarafından küçük harfe çevrilebildiği için kanonik tutulur. */
export const SAFE_METADATA_FIELDS = new Set([
  "sha256", "documentid", "binaryobjectid", "objectclass", "uploadsessionid",
  "generationid", "profileversion",
]);

export type KeyClassification = {
  legacy: boolean;
  maskedPattern: string;
  indicators: string[];
};

/** Harf/rakam dışındaki yalnız yapısal ayraçları koruyan Unicode-güvenli maske. */
export function maskSensitiveText(value: string): string {
  return [...value.normalize("NFKC")].map((character) => {
    if (/\p{Lu}/u.test(character)) return "A";
    if (/\p{L}/u.test(character)) return "a";
    if (/\p{N}/u.test(character)) return "9";
    if (/[/._\- ]/.test(character)) return character;
    return "x";
  }).join("");
}

export const maskObjectKey = maskSensitiveText;

export function isOpaqueKeySegment(segment: string) {
  return UUID_V4_SEGMENT.test(segment) || HEX_TOKEN_SEGMENT.test(segment);
}

function matchesSafeShape(key: string, objectClass: string): boolean {
  const segments = key.split("/");
  if (objectClass === "original") {
    return segments.length === 3 && segments[0] === "originals"
      && isOpaqueKeySegment(segments[1]) && isOpaqueKeySegment(segments[2]);
  }
  if (DERIVED_CLASSES.has(objectClass)) {
    if (segments[0] !== "derivatives" || !isOpaqueKeySegment(segments[1])) return false;
    if (segments.length === 4) {
      return DERIVED_CLASSES.has(segments[2]) && isOpaqueKeySegment(segments[3]);
    }
    if (segments.length === 5) {
      return DERIVED_CLASSES.has(segments[2]) && isOpaqueKeySegment(segments[3])
        && DERIVATIVE_PART.test(segments[4]);
    }
  }
  return false;
}

function valueIndicators(value: string): string[] {
  const indicators = new Set<string>();
  if (/\s/u.test(value)) indicators.add("WHITESPACE");
  if (/[^\x00-\x7F]/u.test(value)) indicators.add("NON_ASCII");
  if (/(?<!\d)\d{11}(?!\d)/u.test(value)) indicators.add("ELEVEN_DIGIT_RUN");
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/u.test(value)) indicators.add("EMAIL_LIKE");
  if (/\.[a-z0-9]{1,8}$/iu.test(value)) indicators.add("FILENAME_LIKE");
  if (/\p{Lu}\p{Ll}+/u.test(value)) indicators.add("NAME_LIKE_CASING");
  return [...indicators].sort();
}

function collectKeyIndicators(key: string): string[] {
  const indicators = new Set(valueIndicators(key));
  const lastSegment = key.split("/").at(-1) ?? "";
  if (/\.[a-z0-9]{1,8}$/iu.test(lastSegment) && !DERIVATIVE_PART.test(lastSegment)) {
    indicators.add("FILENAME_EXTENSION");
  }
  return [...indicators].sort();
}

export function classifyObjectKey(key: string, objectClass: string): KeyClassification {
  const legacy = !matchesSafeShape(key, objectClass);
  return {
    legacy,
    maskedPattern: maskSensitiveText(key),
    indicators: legacy ? collectKeyIndicators(key) : [],
  };
}

function validKnownMetadataValue(field: string, value: string): boolean {
  switch (field) {
    case "sha256": return /^[a-f0-9]{64}$/i.test(value);
    case "documentid":
    case "binaryobjectid":
    case "uploadsessionid":
    case "generationid": return isOpaqueKeySegment(value);
    case "objectclass": return SAFE_OBJECT_CLASSES.has(value);
    case "profileversion": return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value);
    default: return false;
  }
}

/**
 * Metadata bulguları ham alan adı/değer içermez. Bilinmeyen alan adları
 * maskelenir; değerler yalnız sabit sınıflandırma kodlarına dönüştürülür.
 */
export function classifyMetadataFields(customMetadata: Record<string, string> | undefined): string[] {
  if (!customMetadata) return [];
  const findings = new Set<string>();
  for (const [rawField, value] of Object.entries(customMetadata)) {
    const field = rawField.toLowerCase();
    if (!SAFE_METADATA_FIELDS.has(field)) {
      const indicators = valueIndicators(value);
      findings.add(`UNKNOWN_FIELD:${maskSensitiveText(rawField)}${indicators.length ? `:${indicators.join("+")}` : ""}`);
      continue;
    }
    if (!validKnownMetadataValue(field, value)) {
      findings.add(`INVALID_SAFE_VALUE:${maskSensitiveText(rawField)}`);
    }
  }
  return [...findings].sort();
}

/** Yeni hedef yalnız rastgele/opak tokenlardan oluşur; kaynak kimlik kullanılmaz. */
export function secureTargetKey(objectClass: string, documentToken: string, objectToken: string): string {
  if (!ALL_MIGRATABLE_CLASSES.has(objectClass)) throw new Error("Taşınamaz nesne sınıfı.");
  if (!isOpaqueKeySegment(documentToken) || !isOpaqueKeySegment(objectToken)) {
    throw new Error("Güvenli hedef anahtarı opak token gerektirir.");
  }
  return objectClass === "original"
    ? `originals/${documentToken}/${objectToken}`
    : `derivatives/${documentToken}/${objectClass}/${objectToken}`;
}
