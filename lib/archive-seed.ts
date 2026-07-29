/**
 * Kontrollü sözlük ve belge türü profillerinin başlangıç verisi.
 *
 * Bu dosya **veri**dir, iş kuralı değildir: buradaki satırlar veritabanına
 * yazılır ve çalışma zamanında `lib/document-profile.ts` tarafından okunur.
 * Rotalar profil kuralını koddan değil veritabanından alır (ADR-008).
 *
 * Tohumlama idempotenttir ve yalnız eksik kayıtları ekler: kurum bir profili
 * veritabanında güncellerse tohum onu geri almaz. Yeni bir kural sürümü
 * gerektiğinde `profile_version` artırılır ve eski sürüm `valid_to` ile kapatılır
 * (VERI_SOZLUGU.md §15).
 *
 * Durum kodları MUDURLUK_BELGE_TURU_ENVANTERI.md §3'ten gelir. Buradaki bütün
 * profiller `HYPOTHESIS` durumundadır: ilgili müdürlük, arşiv birimi ve
 * hukuk/KVKK onayı almadan `VALIDATED` sayılmazlar.
 */

export const SEED_PROFILE_VERSION = "1.0";
export const DEFAULT_DOCUMENT_TYPE_CODE = "TASNIF_BEKLIYOR";
export const UNIT_VOCABULARY_CODE = "ORGANIZATION_UNIT";
export const NEIGHBORHOOD_VOCABULARY_CODE = "NEIGHBORHOOD";

type SeedVocabulary = {
  code: string;
  name: string;
  owner: string;
  source: string;
  terms: Array<{ code: string; label: string }>;
};

/**
 * Müdürlük listesi geçici bir başlangıç kümesidir; yetkili kaynak personel/kimlik
 * sistemidir (VERI_SOZLUGU.md §14). Mahalle sözlüğü bilinçli olarak boş bırakıldı:
 * yetkili kaynak CBS/adres sözlüğüdür ve uydurma değerle doldurulmamalıdır.
 */
export const seedVocabularies: SeedVocabulary[] = [
  {
    code: UNIT_VOCABULARY_CODE,
    name: "Müdürlük ve organizasyon birimleri",
    owner: "İnsan kaynakları / bilgi işlem",
    source: "Başlangıç kümesi — personel/kimlik sisteminden doğrulanacak",
    terms: [
      { code: "BELIRLENMEDI", label: "Belirlenmedi" },
      { code: "IMAR_VE_SEHIRCILIK", label: "İmar ve Şehircilik Müdürlüğü" },
      { code: "YAPI_KONTROL", label: "Yapı Kontrol Müdürlüğü" },
      { code: "RUHSAT_VE_DENETIM", label: "Ruhsat ve Denetim Müdürlüğü" },
      { code: "ITFAIYE", label: "İtfaiye Müdürlüğü" },
      { code: "YAZI_ISLERI", label: "Yazı İşleri Müdürlüğü" },
      { code: "EMLAK_VE_ISTIMLAK", label: "Emlak ve İstimlak Müdürlüğü" },
      { code: "FEN_ISLERI", label: "Fen İşleri Müdürlüğü" },
      { code: "ZABITA", label: "Zabıta Müdürlüğü" },
      { code: "HUKUK_ISLERI", label: "Hukuk İşleri Müdürlüğü" },
    ],
  },
  {
    code: NEIGHBORHOOD_VOCABULARY_CODE,
    name: "Mahalleler",
    owner: "CBS birimi",
    source: "Yetkili adres/CBS kaynağından aktarılacak — henüz yüklenmedi",
    terms: [],
  },
];

type SeedField = {
  fieldCode: string;
  label: string;
  dataType: "TEXT" | "DATE" | "IDENTIFIER" | "CODE" | "ENTITY_REF";
  cardinality: "one" | "zero_or_one" | "one_or_more" | "many";
  requirement: "OPTIONAL" | "REQUIRED" | "REQUIRED_FOR_ARCHIVE";
  isCritical: boolean;
  formatPattern?: string;
  formatHint?: string;
  vocabularyCode?: string;
  enforceVocabulary?: boolean;
  entityType?: "PARCEL" | "ADDRESS" | "BUILDING" | "BUILDING_UNIT";
};

// Ada ve parsel metindir; `12-A`, `3/1` gibi hukuki ekler korunur.
const PARCEL_TOKEN_PATTERN = "^[0-9]{1,7}([/-][0-9A-Za-zÇĞİÖŞÜçğıöşü]{1,6})?$";
const DATE_PATTERN = "^(0[1-9]|[12][0-9]|3[01])\\.(0[1-9]|1[0-2])\\.(1[89]|20)[0-9]{2}$";

/** Bütün profillerde bulunan ortak alan çekirdeği (MUDURLUK_..._ENVANTERI.md §4). */
function coreFields(required: string[]): SeedField[] {
  const requirementOf = (code: string): SeedField["requirement"] =>
    required.includes(code) ? "REQUIRED" : "OPTIONAL";
  return [
    { fieldCode: "document_type", label: "Belge türü", dataType: "CODE", cardinality: "one", requirement: "REQUIRED", isCritical: true },
    {
      fieldCode: "unit", label: "İlgili müdürlük", dataType: "CODE", cardinality: "one",
      requirement: "REQUIRED", isCritical: true,
      vocabularyCode: UNIT_VOCABULARY_CODE, enforceVocabulary: true,
    },
    {
      fieldCode: "document_date", label: "Belge tarihi", dataType: "DATE", cardinality: "one",
      requirement: requirementOf("document_date"), isCritical: true,
      formatPattern: DATE_PATTERN, formatHint: "Belge tarihi GG.AA.YYYY biçiminde olmalıdır.",
    },
    {
      fieldCode: "neighborhood", label: "Mahalle", dataType: "TEXT", cardinality: "many",
      requirement: requirementOf("neighborhood"), isCritical: false,
      // Sözlük henüz yüklenmediği için değer zorlanmaz; yalnız uyarı üretir.
      vocabularyCode: NEIGHBORHOOD_VOCABULARY_CODE, enforceVocabulary: false,
    },
    {
      fieldCode: "ada", label: "Ada", dataType: "IDENTIFIER", cardinality: "many",
      requirement: requirementOf("ada"), isCritical: true,
      formatPattern: PARCEL_TOKEN_PATTERN, formatHint: "Ada değeri sayı veya `12-A` biçiminde olmalıdır.",
      entityType: "PARCEL",
    },
    {
      fieldCode: "parcel", label: "Parsel", dataType: "IDENTIFIER", cardinality: "many",
      requirement: requirementOf("parcel"), isCritical: true,
      formatPattern: PARCEL_TOKEN_PATTERN, formatHint: "Parsel değeri sayı veya `12-A` biçiminde olmalıdır.",
      entityType: "PARCEL",
    },
    { fieldCode: "addressee", label: "Muhatap", dataType: "TEXT", cardinality: "many", requirement: requirementOf("addressee"), isCritical: false },
  ];
}

type SeedDocumentType = {
  code: string;
  name: string;
  ownerDepartment: string;
  /** OCR tam metninde bu işaretler görülürse belge türü önerilir. */
  detectionMarkers: string[];
  requiredFields: string[];
};

export const seedDocumentTypes: SeedDocumentType[] = [
  {
    code: DEFAULT_DOCUMENT_TYPE_CODE,
    name: "Tasnif bekliyor",
    ownerDepartment: "Belirlenmedi",
    detectionMarkers: [],
    requiredFields: [],
  },
  {
    code: "ENCUMEN_KARARI",
    name: "Encümen karar sureti",
    ownerDepartment: "Yazı İşleri Müdürlüğü",
    detectionMarkers: ["ENCÜMEN KARAR"],
    requiredFields: ["document_date", "neighborhood", "ada", "parcel"],
  },
  {
    code: "YAPI_KULLANMA_IZNI",
    name: "Yapı kullanma izin belgesi",
    ownerDepartment: "İmar ve Şehircilik Müdürlüğü",
    detectionMarkers: ["YAPI KULLANMA İZİN"],
    requiredFields: ["document_date", "neighborhood", "ada", "parcel"],
  },
  {
    code: "NUMARATAJ_TUTANAGI",
    name: "Numarataj tespit tutanağı",
    ownerDepartment: "İmar ve Şehircilik Müdürlüğü",
    detectionMarkers: ["NUMARATAJ"],
    requiredFields: ["document_date", "neighborhood", "ada", "parcel"],
  },
  {
    code: "ISYERI_ACMA_RUHSATI",
    name: "İşyeri açma ruhsatı",
    ownerDepartment: "Ruhsat ve Denetim Müdürlüğü",
    detectionMarkers: ["İŞYERİ AÇMA"],
    requiredFields: ["document_date", "addressee"],
  },
  {
    code: "YANGIN_GUVENLIK_RAPORU",
    name: "Yangın güvenlik raporu",
    ownerDepartment: "İtfaiye Müdürlüğü",
    detectionMarkers: ["YANGIN GÜVENLİK"],
    requiredFields: ["document_date", "addressee"],
  },
];

export function seedFieldsFor(documentTypeCode: string): SeedField[] {
  const type = seedDocumentTypes.find((entry) => entry.code === documentTypeCode);
  return coreFields(type?.requiredFields ?? []);
}

/**
 * Kritik alan her zaman `VERIFY_REQUIRED` olur (ADR-006). Veritabanı bunu CHECK
 * kısıtıyla da uygular; burada tohum verisinin kısıtı ihlal etmemesi sağlanır.
 */
export function extractionPolicyFor(field: SeedField) {
  return field.isCritical ? "VERIFY_REQUIRED" : "SUGGEST";
}
