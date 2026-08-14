import { prepareAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import { requireArchiveSchema, getArchiveBindings, jsonError } from "../../../../../lib/archive-storage";
import { resolveDocumentProfile } from "../../../../../lib/document-profile";
import { MISSING_VALUE, formatViolation, requiredFields, verificationRequiredFields } from "../../../../../lib/field-policy";
import {
  FILE_PLAN_VOCABULARY_CODE, RETENTION_RULE_VOCABULARY_CODE, validateClassification,
} from "../../../../../lib/file-plan";
import { loadVocabularyTerms } from "../../../../../lib/document-profile";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type DocumentState = { status: string; sha256: string; unit: string; document_type: string; document_type_id: string | null };
type TextSummary = { total: number; pending: number };
type RelationSummary = { total: number; pending: number; verified: number };

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const principal = await authorizeRequest(request, bindings.DB, "document.archive", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const DB = bindings.DB;

  const document = await DB.prepare(`SELECT status, sha256, unit, document_type, document_type_id
    FROM archive_documents WHERE id = ?`).bind(id).first<DocumentState>();
  if (!document) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, document.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  if (document.status === "archived") return jsonError("Belge daha önce arşivlenmiş.", 409);
  if (!new Set(["review", "ready"]).has(document.status)) {
    /*
     * Tek bir "hazır değil" cümlesi üç ayrı durumu birleştiriyordu: kuyrukta
     * bekleyen ve işlenen belge kendiliğinden çözülür, OCR'ı başarısız olan
     * çözülmez. Memurun bekleyeceğini mi yoksa yeniden işleme başlatacağını mı
     * bilmesi gerekir; "henüz hazır değil" demek onu bir daha gelip bakmaya
     * gönderir, oysa kayıt kendi başına ilerlemeyecektir.
     */
    const reason: Record<string, string> = {
      queued: "Belge OCR kuyruğunda; metin çıkarımı tamamlanmadan arşivlenemez.",
      processing: "Belgenin OCR işlemi sürüyor; tamamlanmadan arşivlenemez.",
      ocr_failed: "Belgenin OCR işlemi başarısız oldu; arşivlemeden önce yeniden işlenmelidir.",
    };
    return jsonError(reason[document.status] ?? "Belge henüz arşivlemeye hazır değil.", 409);
  }

  const profile = await resolveDocumentProfile(DB, {
    documentTypeId: document.document_type_id,
    documentType: document.document_type,
  });

  const values = await DB.prepare(`SELECT field_name, verification_status,
    COALESCE(corrected_value, field_value) AS value FROM extracted_fields WHERE document_id = ?`)
    .bind(id).all<{ field_name: string; verification_status: string; value: string }>();
  if (!values.results.length) return jsonError("Arşivleme için doğrulanmış OCR alanı bulunamadı.", 409);

  /**
   * Doğrulama zorunluluğu profilden gelir: `VERIFY_REQUIRED` alanlarda hiçbir
   * değer öneri durumunda kalamaz (ADR-006). `SUGGEST` alanlarda kurum
   * doğrulamayı zorunlu tutmamayı seçebilir.
   */
  const mustVerify = new Set(verificationRequiredFields(profile).map((field) => field.fieldCode));
  const pendingCritical = values.results.filter((row) =>
    row.verification_status === "SUGGESTED" && mustVerify.has(row.field_name));
  if (pendingCritical.length) {
    const labels = [...new Set(pendingCritical.map((row) => profile.byCode.get(row.field_name)?.label ?? row.field_name))];
    return jsonError(`Kontrol bekleyen alanlar tamamlanmadan belge arşivlenemez: ${labels.join(", ")}.`, 409);
  }

  // Profilde zorunlu her alan için kullanılabilir en az bir doğrulanmış değer
  // bulunmalıdır: reddedilmiş veya boş bırakılmış zorunlu alan arşivlemeyi durdurur.
  const usable = new Set(values.results
    .filter((row) => ["CONFIRMED", "CORRECTED"].includes(row.verification_status) && row.value !== MISSING_VALUE)
    .map((row) => row.field_name));
  if (!usable.size) return jsonError("Arşivleme için en az bir doğrulanmış alan değeri gereklidir.", 409);
  const missing = requiredFields(profile).filter((field) => !usable.has(field.fieldCode));
  if (missing.length) {
    return jsonError(`Şu alanlar doğrulanmış bir değer olmadan arşivlenemez: ${missing.map((field) => field.label).join(", ")}.`, 409);
  }

  /*
   * Biçim ihlali düzeltme anında yalnız uyarıdır: personel belgede ne yazıyorsa
   * onu girebilmelidir, kayıt sırasında yolu kapatmak tutanağı çarpıtır. Ama
   * arşivleme geri alınamaz — ADR-016 gereği arşivlenmiş kayıt hiçbir yazma
   * yolundan değiştirilemez. Biçim kuralını çiğneyen bir değer arşive girerse
   * kalıcı olarak yanlış kalır ve ada/parsel gibi alanlarda belge parselden bir
   * daha bulunamaz. Uyarının karara bağlanacağı yer burasıdır: ya değer
   * düzeltilir ya da profildeki kural kurumca genişletilir.
   */
  const malformed = values.results
    .filter((row) => ["CONFIRMED", "CORRECTED"].includes(row.verification_status) && row.value !== MISSING_VALUE)
    .map((row) => ({ row, violation: formatViolation(profile.byCode.get(row.field_name), row.value) }))
    .filter((entry) => entry.violation);
  if (malformed.length) {
    const reasons = [...new Set(malformed.map((entry) => entry.violation))];
    return jsonError(`Biçim kuralına uymayan değerler arşivlenemez: ${reasons.join(" ")}`, 409);
  }

  const textSummary = await DB.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN confirmed_text IS NULL THEN 1 ELSE 0 END) AS pending
    FROM ocr_pages WHERE document_id = ?`).bind(id).first<TextSummary>();
  if (!textSummary?.total) return jsonError("Arşivleme için OCR tam metni bulunamadı.", 409);
  if (Number(textSummary.pending ?? 0) > 0) return jsonError("Tam metin personel tarafından onaylanmadan belge arşivlenemez.", 409);

  // Varlık ilişkisi önerileri de karara bağlanmalıdır: doğrulanmamış bir öneri
  // arşivlenmiş belgede askıda kalmamalıdır (VERI_SOZLUGU.md §10).
  const relationSummary = await DB.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN verification_status = 'SUGGESTED' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN verification_status = 'VERIFIED' THEN 1 ELSE 0 END) AS verified
    FROM document_entity_relations WHERE document_id = ?`).bind(id).first<RelationSummary>();
  if (Number(relationSummary?.pending ?? 0) > 0) {
    return jsonError("Kontrol bekleyen varlık ilişkileri karara bağlanmadan belge arşivlenemez.", 409);
  }

  /*
   * design.md §9.5 kararı: arşivleme tasnifi ZORUNLUDUR ve arşivleme anında
   * istenir. Arşiv kaydı WORM'a girdikten sonra tasniflenemez; dosya planı ve
   * saklama kuralı olmadan giren belge saklama hesabının dışında kalır
   * (ADR-016: saklama bitişi onaylı plandan hesaplanır). Kod + etiket karar
   * anının anlık görüntüsü olarak yazılır — sözlük sonradan değişse bile
   * tasnif okunur kalır.
   */
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const [filePlanTerms, retentionTerms] = await Promise.all([
    loadVocabularyTerms(DB, FILE_PLAN_VOCABULARY_CODE),
    loadVocabularyTerms(DB, RETENTION_RULE_VOCABULARY_CODE),
  ]);
  const classification = validateClassification(body, filePlanTerms, retentionTerms);
  if (typeof classification === "string") return jsonError(classification, 409);

  const audit = await prepareAuditEvent(DB, {
    documentId: id,
    actor: principal.email,
    action: "document.archived",
    details: {
      fromStatus: document.status, toStatus: "archived",
      fieldValueCount: values.results.length, confirmedTextPages: textSummary.total,
      verifiedRelations: Number(relationSummary?.verified ?? 0),
      profileCode: profile.code, profileVersion: profile.profileVersion,
      profileStatus: profile.profileStatus,
      requiredFields: requiredFields(profile).map((field) => field.fieldCode),
      sourceSha256: document.sha256,
      filePlan: { code: classification.filePlanCode, label: classification.filePlanLabel },
      retentionRule: { code: classification.retentionRuleCode, label: classification.retentionRuleLabel },
    },
  });
  await DB.batch([
    DB.prepare(`UPDATE archive_documents SET status = 'archived',
        file_plan_code = ?, file_plan_label = ?, retention_rule_code = ?, retention_rule_label = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(classification.filePlanCode, classification.filePlanLabel,
        classification.retentionRuleCode, classification.retentionRuleLabel, id),
    audit.statement,
  ]);
  return Response.json({
    archived: true, documentId: id, auditEvent: audit.eventNumber, eventHash: audit.eventHash,
    profile: { code: profile.code, version: profile.profileVersion },
    verifiedRelations: Number(relationSummary?.verified ?? 0),
    filePlan: { code: classification.filePlanCode, label: classification.filePlanLabel },
    retentionRule: { code: classification.retentionRuleCode, label: classification.retentionRuleLabel },
  });
}
