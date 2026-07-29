/**
 * Alan politikası değerlendirmesi.
 *
 * Kurallar bu dosyada **tanımlı değildir**: çokluk, kritiklik, zorunluluk, biçim
 * ve sözlük bağı `field_definitions` tablosundan gelir (`lib/document-profile.ts`).
 * Bu modül yalnız yüklenmiş tanımı uygular — risk seviyesi, biçim ihlali ve
 * arşivleme zorunluluğu hesabı.
 *
 * Bir kuralı değiştirmek için kod değil profil verisi güncellenir (ADR-008).
 */

import type { DocumentProfile, FieldDefinition } from "./document-profile";

/** VERI_SOZLUGU.md §8: doğrulama durumu; model güveninden ayrı tutulur. */
export type VerificationStatus = "SUGGESTED" | "CONFIRMED" | "CORRECTED" | "REJECTED";

/** VERI_SOZLUGU.md §8: iş kuralı ve tutarlılık değerlendirmesi; güven değeri değildir. */
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type FieldOrigin = "OCR" | "HUMAN";

/** OCR bir alanı bulamadığında yazılan yer tutucu. */
export const MISSING_VALUE = "Belirlenmedi";

export function fieldLabel(profile: DocumentProfile, fieldCode: string) {
  return profile.byCode.get(fieldCode)?.label ?? fieldCode;
}

export function isKnownField(profile: DocumentProfile, fieldCode: string) {
  return profile.byCode.has(fieldCode);
}

export function isMultiValueField(definition: FieldDefinition | undefined) {
  return definition?.cardinality === "many" || definition?.cardinality === "one_or_more";
}

export function isCriticalField(definition: FieldDefinition | undefined) {
  // Tanımı bilinmeyen alan güvenli tarafta kritik sayılır.
  return definition ? definition.isCritical : true;
}

/** Profilde çıkarımı kapatılmamış alan kodları. */
export function extractableFieldCodes(profile: DocumentProfile) {
  return profile.fields.filter((field) => field.extractionPolicy !== "NONE").map((field) => field.fieldCode);
}

/**
 * Belge türü profilinde bulunması beklenen alanlar. OCR bulamazsa kayıt yine
 * oluşturulur ve personel girişine zorlanır.
 */
export function requiredFields(profile: DocumentProfile) {
  return profile.fields.filter((field) => field.requirement !== "OPTIONAL");
}

/** Arşivleme öncesi karara bağlanması zorunlu alanlar (ADR-006). */
export function verificationRequiredFields(profile: DocumentProfile) {
  return profile.fields.filter((field) => field.extractionPolicy === "VERIFY_REQUIRED");
}

/**
 * Profilden gelen biçim kalıbını derler.
 *
 * Kalıp veri olduğu için geçersiz olabilir; bozuk bir kalıp doğrulamayı kapatır,
 * isteği düşürmez. Kalıp uzunluğu veritabanı kısıtıyla sınırlıdır ve doğrulanan
 * değerler en fazla 500 karakterdir.
 */
const compiled = new Map<string, RegExp | null>();
function patternFor(definition: FieldDefinition | undefined) {
  if (!definition?.formatPattern) return null;
  const cached = compiled.get(definition.formatPattern);
  if (cached !== undefined) return cached;
  let expression: RegExp | null = null;
  try {
    expression = new RegExp(definition.formatPattern, "u");
  } catch {
    expression = null;
  }
  compiled.set(definition.formatPattern, expression);
  return expression;
}

/** Biçim kuralı ihlali varsa insan okunur gerekçe döner; yoksa `null`. */
export function formatViolation(definition: FieldDefinition | undefined, value: string): string | null {
  const expression = patternFor(definition);
  if (!expression || !value.trim()) return null;
  if (expression.test(value.trim())) return null;
  return definition?.formatHint ?? `${definition?.label ?? "Alan"} biçimi geçersiz.`;
}

/**
 * Kontrollü sözlük ihlali. `terms` `null` ise sözlük henüz yüklenmemiştir ve
 * doğrulama yapılmaz — boş sözlük her değeri geçersiz saymamalıdır.
 */
export function vocabularyViolation(
  definition: FieldDefinition | undefined,
  value: string,
  terms: Array<{ code: string; label: string }> | null,
): string | null {
  if (!definition?.vocabularyCode || !terms || !value.trim()) return null;
  const normalized = value.trim().toLocaleLowerCase("tr");
  const known = terms.some((term) => term.label.toLocaleLowerCase("tr") === normalized || term.code.toLocaleLowerCase("tr") === normalized);
  if (known) return null;
  return `${definition.label} değeri "${value}" kontrollü listede bulunmuyor.`;
}

/**
 * Risk seviyesi; model güveni + biçim/sözlük doğrulaması + kritiklik birlikte
 * değerlendirilir. PROJE_PLANI.md'nin 2. düzeltme maddesi gereği güven değeri
 * tek başına risk olarak kullanılmaz.
 */
export function assessRisk(input: {
  definition: FieldDefinition | undefined;
  value: string;
  confidence: number;
  origin?: FieldOrigin;
  violations?: Array<string | null>;
}): RiskLevel {
  const critical = isCriticalField(input.definition);
  const missing = !input.value.trim() || input.value === MISSING_VALUE;
  if (missing) return critical ? "CRITICAL" : "HIGH";
  const failed = (input.violations ?? [formatViolation(input.definition, input.value)]).some(Boolean);
  if (failed) return critical ? "CRITICAL" : "HIGH";
  // Personelin girdiği değerde model güveni yoktur; risk yalnız biçim ve
  // kritiklikten gelir. Model güveni riskin yerine geçmez.
  if (input.origin === "HUMAN") return critical ? "MEDIUM" : "LOW";
  if (critical && input.confidence < 0.9) return "HIGH";
  if (input.confidence < 0.75) return "HIGH";
  if (input.confidence < 0.9) return "MEDIUM";
  return critical ? "MEDIUM" : "LOW";
}
