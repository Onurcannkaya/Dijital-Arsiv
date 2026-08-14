/**
 * Dosya planı ve saklama kuralı — kontrollü sözlükler.
 *
 * design.md §9.5 kararı (2026-08-14): tasnif, ARŞİVLEME ANINDA ve ZORUNLU
 * olarak istenir. "Doğrula ve arşivle" diyaloğunda dosya planı ile saklama
 * kuralı seçilmeden belge arşivlenemez; sunucu da kabul etmez. Tasnif
 * arşivcinin işidir ve belge türü ancak doğrulama bittiğinde kesinleşmiştir —
 * yükleme anı bunun için fazla erkendir (ANA_SISTEM_TASARIM_BELGESI.md §190
 * her belgede dosya planı ve saklama kuralı öngörür; akış adımı 145/8 "belge
 * türü profili, dosya planı, erişim ve saklama kuralı tamamlanır" der).
 *
 * İki liste de `vocabulary_terms` içinde yaşar ve ayarlardan yönetilir.
 * BAŞLANGIÇ KÜMESİ TASLAKTIR: ADR-016 gereği kurumsal dosya planı ve saklama
 * planı yetkili onaydan geçmeden üretim aslı kilitlenmez; buradaki kayıtlar
 * mekanizmayı çalıştırır, kurumun onaylı planı geldiğinde sözlük ayarlardan
 * güncellenir. Kod + etiket, karar anında belgenin üzerine ANLIK GÖRÜNTÜ
 * olarak yazılır (ret gerekçesi deseni): sözlük sonradan değişse bile
 * denetçi, arşivleme anındaki tasnifin ne anlama geldiğini okuyabilir.
 */

import type { ManagedVocabulary } from "./vocabulary-directory.ts";

export const FILE_PLAN_VOCABULARY_CODE = "FILE_PLAN";
export const RETENTION_RULE_VOCABULARY_CODE = "RETENTION_RULE";

export type ClassificationTerm = { code: string; label: string };

/**
 * Dosya planı — taslak başlangıç kümesi (Standart Dosya Planı deseninde).
 * Kurumun onaylı planı ayarlardaki sözlük yönetiminden işlenir.
 */
export const SEED_FILE_PLAN: readonly ClassificationTerm[] = [
  { code: "SDP-105-01", label: "105.01 İmar uygulama işlemleri (taslak)" },
  { code: "SDP-105-02", label: "105.02 Yapı ruhsatı işlemleri (taslak)" },
  { code: "SDP-105-03", label: "105.03 Yapı kullanma izni işlemleri (taslak)" },
  { code: "SDP-105-04", label: "105.04 Numarataj işlemleri (taslak)" },
  { code: "SDP-050-01", label: "050.01 Meclis ve encümen kararları (taslak)" },
  { code: "SDP-622-01", label: "622.01 Vatandaş başvuruları (taslak)" },
];

/**
 * Saklama kuralı — taslak başlangıç kümesi. Süre dolmuşluk otomatik silme
 * DEĞİLDİR (ADR-016): kural yalnız saklama sınıfını kayda bağlar; tasfiye
 * ayrı, kurullu bir süreçtir ve ilk üretim döneminde kapalıdır (ADR-018).
 */
export const SEED_RETENTION_RULES: readonly ClassificationTerm[] = [
  { code: "SUREKLI", label: "Sürekli saklama — Devlet Arşivlerine devir değerlendirmesi (taslak)" },
  { code: "10-YIL", label: "10 yıl — sonra ayıklama/imha değerlendirmesi (taslak)" },
  { code: "5-YIL", label: "5 yıl — sonra ayıklama/imha değerlendirmesi (taslak)" },
];

export type ClassificationInput = {
  filePlanCode?: unknown;
  retentionRuleCode?: unknown;
};
export type ValidatedClassification = {
  filePlanCode: string; filePlanLabel: string;
  retentionRuleCode: string; retentionRuleLabel: string;
};

/**
 * Arşivleme tasnifini yürürlükteki sözlüklere göre doğrular; geçersizse insan
 * okunur mesaj döner. Ret gerekçesi deseniyle aynı: sözlük yüklenmemişse
 * serbest geçiş verilmez — tasnifsiz arşivlenen belge WORM kilidinin ardından
 * bir daha tasniflenemez, oysa eksik sözlük dakikalar içinde giderilir.
 */
export function validateClassification(
  input: ClassificationInput,
  filePlanTerms: readonly ClassificationTerm[] | null,
  retentionTerms: readonly ClassificationTerm[] | null,
): ValidatedClassification | string {
  if (!filePlanTerms?.length || !retentionTerms?.length) {
    return "Dosya planı/saklama kuralı sözlüğü yüklenmemiş; şema göçü çalıştırılmadan arşivleme yapılamaz.";
  }
  const filePlanCode = typeof input.filePlanCode === "string" ? input.filePlanCode.trim() : "";
  const retentionCode = typeof input.retentionRuleCode === "string" ? input.retentionRuleCode.trim() : "";
  if (!filePlanCode || !retentionCode) {
    return "Dosya planı ve saklama kuralı seçilmeden belge arşivlenemez.";
  }
  const filePlan = filePlanTerms.find((term) => term.code === filePlanCode);
  if (!filePlan) return `Dosya planı kontrollü listede bulunmuyor: ${filePlanCode}.`;
  const retention = retentionTerms.find((term) => term.code === retentionCode);
  if (!retention) return `Saklama kuralı kontrollü listede bulunmuyor: ${retentionCode}.`;
  return {
    filePlanCode: filePlan.code, filePlanLabel: filePlan.label,
    retentionRuleCode: retention.code, retentionRuleLabel: retention.label,
  };
}

/** İki sözlüğün ayarlar ekranından yönetilebilir tanımı (ortak kurallar). */
export function classificationVocabulary(kind: "file-plan" | "retention-rule"): ManagedVocabulary {
  const isPlan = kind === "file-plan";
  const noun = isPlan ? "Dosya planı kalemi" : "Saklama kuralı";
  return {
    vocabularyCode: isPlan ? FILE_PLAN_VOCABULARY_CODE : RETENTION_RULE_VOCABULARY_CODE,
    targetKind: kind,
    actions: { created: "classification.created", updated: "classification.updated" },
    errorCodes: { exists: "TERM_EXISTS", notFound: "TERM_NOT_FOUND", lastActive: "LAST_TERM" },
    messages: {
      vocabularyMissing: `${noun} sözlüğü kurulu değil; şema göçünü çalıştırın.`,
      invalidLabel: `${noun} 1 ile 120 karakter arasında olmalıdır.`,
      labelUnusable: `${noun} metninden geçerli bir kod üretilemedi.`,
      exists: `Bu ${isPlan ? "dosya planı kalemi" : "saklama kuralı"} zaten tanımlı.`,
      notFound: `${noun} bulunamadı.`,
      lastActive: "Listede en az bir aktif kayıt kalmalıdır; aksi halde hiçbir belge arşivlenemez.",
    },
    usageCounts: async (db, term) => {
      const column = isPlan ? "file_plan_code" : "retention_rule_code";
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM archive_documents
        WHERE ${column} = ?`).bind(term.code).first<{ count: number }>();
      return [{ label: "arşivlenmiş belge", count: Number(row?.count ?? 0) }];
    },
  };
}
