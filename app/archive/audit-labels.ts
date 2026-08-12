/**
 * Denetim olaylarının Türkçe etiketleri.
 *
 * Belge inceleme ekranı ve kurum geneli işlem geçmişi aynı listeyi kullanır;
 * ayrı kopyalar zamanla kayar ve aynı olay iki ekranda farklı adlandırılır.
 * Etiketi olmayan bir olay ham kodu ile gösterilir (uydurma ad üretilmez).
 */
export const auditLabels: Record<string, string> = {
  "document.received": "Belge kabul edildi",
  "ocr.completed": "OCR tamamlandı",
  "fields.confirmed": "Alanlar doğrulandı",
  "text.confirmed": "Tam metin onaylandı",
  "text.corrected": "Tam metin düzeltildi",
  "relation.verified": "Varlık ilişkisi doğrulandı",
  "relation.rejected": "Varlık ilişkisi reddedildi",
  "document.archived": "Belge arşivlendi",
  "document.derivative-created": "Görüntüleme kopyası üretildi",
  "document.ticket-issued": "Erişim bileti verildi",
  "document.viewed": "Belge görüntülendi",
  "document.downloaded": "Belge indirildi",
  "document.access-denied": "Erişim reddedildi",
  "document.key-migrated": "Nesne anahtarı taşındı",
  "document.portable-restored": "Taşınabilir paketten geri yüklendi",
  "user.created": "Kullanıcı eklendi",
  "user.updated": "Kullanıcı güncellendi",
};

/** Erişim reddi gibi olaylarda gösterilen sabit neden kodları. */
export const auditReasonLabels: Record<string, string> = {
  CREDENTIAL_REQUIRED: "kimlik bilgisi verilmedi",
  TICKET_INVALID: "bilet geçersiz ya da süresi dolmuş",
  SESSION_INVALID: "görüntüleme oturumu geçersiz",
  URL_CREDENTIAL_REJECTED: "kimlik bilgisi adres satırında gönderildi",
};
