/**
 * Ret gerekçeleri — kontrollü sözlük.
 *
 * Denetim izi değişmezdir (ADR-016) ve bir zamanlar "kim reddetti, ne zaman"
 * bilgisini tutuyor, "neden" bilgisini tutmuyordu. Bir taşınmaz dosyasında
 * yıllar sonra sorulacak soru tam olarak budur: bu ada/parsel bağı neden
 * koparıldı, bu alan değeri neden atıldı?
 *
 * Gerekçe serbest metin değil kontrollü koddur: "yanlış", "hatalı", "x" gibi
 * girdiler birikir ve sonradan raporlanamaz. Kodlanmış gerekçe, OCR'ın nerede
 * ve ne sıklıkla yanıldığını ölçmeyi de mümkün kılar; bu ölçüm olmadan model
 * ve profil ayarı körlemesine yapılır.
 *
 * Liste `vocabulary_terms` tablosunda yaşar — müdürlük ve mahalle sözlükleri
 * gibi. Kurum kendi gerekçesini ekleyebilmeli, kullanmadığını pasifleştirebilmeli
 * ve bunu yeni bir sürüm beklemeden yapabilmelidir. Buradaki diziler yalnız
 * BAŞLANGIÇ kümesidir; göç `ON CONFLICT DO NOTHING` ile yazar, kurumun
 * düzenlemesini geri almaz.
 *
 * `OTHER` listenin dışında kalan durum içindir ve serbest açıklamayı ZORUNLU
 * kılar; aksi halde listeden kaçış yolu haline gelir ve liste anlamsızlaşır.
 */

export const FIELD_REJECTION_VOCABULARY_CODE = "FIELD_REJECTION_REASON";
export const RELATION_REJECTION_VOCABULARY_CODE = "RELATION_REJECTION_REASON";
export const OTHER_REASON_CODE = "OTHER";
export const MAX_REJECTION_NOTE = 300;

export type RejectionReason = { code: string; label: string };

/** Alan değeri reddi — başlangıç kümesi. */
export const SEED_FIELD_REJECTION_REASONS: readonly RejectionReason[] = [
  { code: "NOT_IN_DOCUMENT", label: "Belgede böyle bir bilgi yok" },
  { code: "MISREAD", label: "Yanlış okunmuş (OCR hatası)" },
  { code: "WRONG_FIELD", label: "Değer başka bir alana ait" },
  { code: "ILLEGIBLE", label: "Kanıt okunamıyor" },
  { code: "DUPLICATE", label: "Mükerrer değer" },
  { code: OTHER_REASON_CODE, label: "Diğer (açıklama girin)" },
];

/** Varlık ilişkisi reddi — başlangıç kümesi. */
export const SEED_RELATION_REJECTION_REASONS: readonly RejectionReason[] = [
  { code: "WRONG_ENTITY", label: "Belge bu taşınmaza ait değil" },
  { code: "MISREAD", label: "Ada/parsel yanlış okunmuş" },
  { code: "ILLEGIBLE", label: "Kanıt okunamıyor" },
  { code: "DUPLICATE", label: "Mükerrer ilişki" },
  { code: OTHER_REASON_CODE, label: "Diğer (açıklama girin)" },
];

export type RejectionInput = { reasonCode?: unknown; reasonNote?: unknown };
export type ValidatedRejection = { reasonCode: string; reasonLabel: string; reasonNote: string | null };

/**
 * Ret gerekçesini yürürlükteki sözlüğe göre doğrular; geçersizse insan okunur
 * mesaj döner.
 *
 * `terms` `null` ise sözlük yüklenmemiştir. Bu durumda serbest geçiş
 * verilmez: gerekçesiz bir ret değişmez ize girerse bir daha düzeltilemez,
 * oysa eksik sözlük işletim tarafında dakikalar içinde giderilebilir.
 *
 * Etiket de kayda yazılır: kurum listeyi düzenlediğinde bile denetçi, kararın
 * verildiği andaki gerekçenin ne anlama geldiğini okuyabilmelidir.
 */
export function validateRejection(
  input: RejectionInput,
  terms: readonly RejectionReason[] | null,
): ValidatedRejection | string {
  if (!terms?.length) {
    return "Ret gerekçesi sözlüğü yüklenmemiş; şema göçü çalıştırılmadan ret kaydedilemez.";
  }
  const code = typeof input.reasonCode === "string" ? input.reasonCode.trim() : "";
  if (!code) return "Ret gerekçesi seçilmelidir.";
  const reason = terms.find((entry) => entry.code === code);
  if (!reason) return `Ret gerekçesi kontrollü listede bulunmuyor: ${code}.`;
  const note = typeof input.reasonNote === "string"
    ? input.reasonNote.trim().slice(0, MAX_REJECTION_NOTE) : "";
  if (code === OTHER_REASON_CODE && !note) {
    return "\"Diğer\" gerekçesi seçildiğinde açıklama zorunludur.";
  }
  return { reasonCode: code, reasonLabel: reason.label, reasonNote: note || null };
}
