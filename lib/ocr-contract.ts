export type OcrBox = [number, number, number, number];

export type OcrWord = {
  text: string;
  confidence: number;
  box: OcrBox;
};

export type OcrPage = {
  pageNumber: number;
  width: number;
  height: number;
  rawText: string;
  fullText: string;
  averageConfidence: number;
  words: OcrWord[];
};

export type ExtractedField = {
  name: string;
  value: string;
  normalizedValue?: string | null;
  confidence: number;
  pageNumber: number;
  box: OcrBox;
  evidenceText: string;
  /**
   * Aynı gerçek dünya referansına ait alanların ortak etiketi. Örneğin bir
   * `N ada M parsel` ifadesinden çıkan `ada` ve `parcel` değerleri aynı grubu
   * taşır; varlık ilişkisi bu eşleşmeye göre kurulur. Boş olabilir.
   */
  group?: string | null;
};

/**
 * Görüntüleme için kontrollü erişim türevi.
 *
 * Asıl dosya yalnız indirme yetkisiyle sunulur; görüntüleme bu türevi alır
 * (S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5). PDF'lerde üretilmez.
 */
export type AccessDerivative = {
  mediaType: string;
  byteSize: number;
  base64: string;
};

export type OcrServiceResult = {
  engine: string;
  model: string;
  durationMs: number;
  /** Çıkarımda kullanılan belge türü profili ve sözlük sürümü (varsa). */
  profileVersion: string | null;
  vocabularyVersion: string | null;
  accessDerivative: AccessDerivative | null;
  pages: OcrPage[];
  fields: ExtractedField[];
};

/** Türev boyutu sınırı: bozuk veya aşırı büyük yanıt kabul edilmez. */
const MAX_ACCESS_DERIVATIVE_BYTES = 8 * 1024 * 1024;
const ACCESS_DERIVATIVE_MEDIA_TYPES = new Set(["image/jpeg"]);

function decodedBase64Size(value: string) {
  if (!value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function parseAccessDerivative(value: unknown): AccessDerivative | null {
  if (!value || typeof value !== "object") return null;
  const derivative = value as Record<string, unknown>;
  if (typeof derivative.mediaType !== "string" || typeof derivative.base64 !== "string" || !isNumber(derivative.byteSize)) {
    return null;
  }
  if (derivative.byteSize <= 0 || derivative.byteSize > MAX_ACCESS_DERIVATIVE_BYTES) return null;
  if (!ACCESS_DERIVATIVE_MEDIA_TYPES.has(derivative.mediaType)) return null;
  if (derivative.base64.length > Math.ceil(MAX_ACCESS_DERIVATIVE_BYTES / 3) * 4 + 4) return null;
  if (decodedBase64Size(derivative.base64) !== derivative.byteSize) return null;
  return { mediaType: derivative.mediaType, byteSize: derivative.byteSize, base64: derivative.base64 };
}

/**
 * OCR servisine gönderilen belge türü profili.
 *
 * Müdürlük ve belge türü sözlükleri koda gömülmez; kontrollü listeden okunup
 * istekle taşınır (PROJE_PLANI.md 8. düzeltme maddesi).
 */
export type OcrProfilePayload = {
  profileVersion: string;
  vocabularyVersion: string | null;
  units: string[];
  documentTypes: Array<{ name: string; markers: string[] }>;
};

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBox(value: unknown): value is OcrBox {
  return Array.isArray(value) && value.length === 4 && value.every(isNumber);
}

export function parseOcrServiceResult(value: unknown): OcrServiceResult {
  if (!value || typeof value !== "object") throw new Error("OCR servisi geçersiz yanıt verdi.");
  const data = value as Record<string, unknown>;
  if (typeof data.engine !== "string" || typeof data.model !== "string" || !isNumber(data.durationMs)) {
    throw new Error("OCR servis kimliği veya süresi eksik.");
  }
  if (!Array.isArray(data.pages) || !Array.isArray(data.fields)) throw new Error("OCR sayfa veya alan sonuçları eksik.");

  const pages = data.pages.map((item) => {
    const page = item as Record<string, unknown>;
    if (!isNumber(page.pageNumber) || !isNumber(page.width) || !isNumber(page.height) || typeof page.rawText !== "string" || typeof page.fullText !== "string" || !isNumber(page.averageConfidence) || !Array.isArray(page.words)) {
      throw new Error("OCR sayfa sonucu geçersiz.");
    }
    const words = page.words.map((wordValue) => {
      const word = wordValue as Record<string, unknown>;
      if (typeof word.text !== "string" || !isNumber(word.confidence) || !isBox(word.box)) throw new Error("OCR kelime kanıtı geçersiz.");
      return { text: word.text, confidence: word.confidence, box: word.box };
    });
    return { pageNumber: page.pageNumber, width: page.width, height: page.height, rawText: page.rawText, fullText: page.fullText, averageConfidence: page.averageConfidence, words };
  });

  const fields = data.fields.map((item) => {
    const field = item as Record<string, unknown>;
    if (typeof field.name !== "string" || typeof field.value !== "string" || !isNumber(field.confidence) || !isNumber(field.pageNumber) || !isBox(field.box) || typeof field.evidenceText !== "string") {
      throw new Error("OCR alan kanıtı geçersiz.");
    }
    return {
      name: field.name,
      value: field.value,
      normalizedValue: typeof field.normalizedValue === "string" ? field.normalizedValue : null,
      confidence: field.confidence,
      pageNumber: field.pageNumber,
      box: field.box,
      evidenceText: field.evidenceText,
      group: typeof field.group === "string" && field.group.trim() ? field.group.trim() : null,
    };
  });

  return {
    engine: data.engine,
    model: data.model,
    durationMs: data.durationMs,
    profileVersion: typeof data.profileVersion === "string" ? data.profileVersion : null,
    vocabularyVersion: typeof data.vocabularyVersion === "string" ? data.vocabularyVersion : null,
    accessDerivative: parseAccessDerivative(data.accessDerivative),
    pages,
    fields,
  };
}
