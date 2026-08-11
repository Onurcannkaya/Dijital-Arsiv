import { authorizeRequest, canAccessUnit } from "../../../../lib/authorization";
import { requireArchiveSchema, getArchiveBindings, jsonError } from "../../../../lib/archive-storage";
import { loadVocabularyTerms, resolveDocumentProfile } from "../../../../lib/document-profile";
import { listDocumentRelations } from "../../../../lib/entities";
import { isMultiValueField } from "../../../../lib/field-policy";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type DocumentRow = { id:string; reference_no:string; original_name:string; media_type:string; byte_size:number; sha256:string; document_type:string; document_type_id:string|null; document_profile_version:string|null; unit:string; status:string; uploaded_by:string; created_at:string; updated_at:string };
type FieldRow = { id:string; field_name:string; value_index:number; field_value:string; normalized_value:string|null; confidence:number; risk_level:string; page_number:number; bbox_json:string; evidence_text:string; model:string; verification_status:string; origin:string; verified_by:string|null; verified_at:string|null; corrected_value:string|null; corrected_by:string|null; corrected_at:string|null };
type PageRow = { page_number:number; width:number; height:number; raw_text:string; full_text:string; search_text:string; confirmed_text:string|null; confirmed_by:string|null; confirmed_at:string|null; words_json:string; average_confidence:number; model:string };
type AuditRow = { event_number:number; actor:string; action:string; details_json:string; previous_hash:string|null; event_hash:string; created_at:string };
type ObjectRow = { id:string; object_class:string; media_type:string; byte_size:number; sha256:string; retention_status:string; legal_hold_status:string; generator:string|null; derived_from_id:string|null; created_at:string };

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const row = await bindings.DB.prepare(`SELECT id, reference_no, original_name, media_type, byte_size, sha256,
    document_type, document_type_id, document_profile_version, unit, status, uploaded_by, created_at, updated_at
    FROM archive_documents WHERE id = ?`).bind(id).first<DocumentRow>();
  if (!row) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, row.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  const [pages, fields, audit, objects, relations] = await Promise.all([
    bindings.DB.prepare(`SELECT page_number, width, height, raw_text, full_text, search_text, confirmed_text, confirmed_by, confirmed_at, words_json, average_confidence, model FROM ocr_pages WHERE document_id = ? ORDER BY page_number`).bind(id).all<PageRow>(),
    bindings.DB.prepare(`SELECT id, field_name, value_index, field_value, normalized_value, confidence, risk_level,
      page_number, bbox_json, evidence_text, model, verification_status, origin, verified_by, verified_at,
      corrected_value, corrected_by, corrected_at FROM extracted_fields WHERE document_id = ?
      ORDER BY field_name, value_index`).bind(id).all<FieldRow>(),
    bindings.DB.prepare(`SELECT event_number, actor, action, details_json, previous_hash, event_hash, created_at FROM audit_events WHERE document_id = ? ORDER BY event_number DESC LIMIT 25`).bind(id).all<AuditRow>(),
    bindings.DB.prepare(`SELECT id, object_class, media_type, byte_size, sha256,
      retention_status, legal_hold_status, generator, derived_from_id, created_at FROM binary_objects
      WHERE document_id = ? ORDER BY CASE object_class WHEN 'original' THEN 0 ELSE 1 END, created_at`).bind(id).all<ObjectRow>(),
    listDocumentRelations(bindings.DB, id),
  ]);

  // Alan kuralları belge türü profilinden okunur (ADR-008).
  const profile = await resolveDocumentProfile(bindings.DB, {
    documentTypeId: row.document_type_id,
    documentType: row.document_type,
  });
  const vocabularyCodes = [...new Set(profile.fields.map((field) => field.vocabularyCode).filter((code): code is string => Boolean(code)))];
  const vocabularies = Object.fromEntries(await Promise.all(vocabularyCodes.map(async (code) =>
    [code, await loadVocabularyTerms(bindings.DB, code)] as const)));

  const values = fields.results.map((field) => ({
    id: field.id,
    name: field.field_name,
    label: profile.byCode.get(field.field_name)?.label ?? field.field_name,
    valueIndex: field.value_index,
    value: field.corrected_value ?? field.field_value,
    originalValue: field.field_value,
    normalizedValue: field.normalized_value,
    confidence: field.confidence,
    riskLevel: field.risk_level,
    verificationStatus: field.verification_status,
    origin: field.origin,
    pageNumber: field.page_number,
    box: JSON.parse(field.bbox_json),
    evidenceText: field.evidence_text,
    model: field.model,
    verifiedBy: field.verified_by,
    verifiedAt: field.verified_at,
    corrected: Boolean(field.corrected_value),
    correctedBy: field.corrected_by,
    correctedAt: field.corrected_at,
  }));

  /**
   * Alan grupları profil sırasına göre kurulur; profilde tanımlı ama değeri
   * olmayan alanlar da listelenir, böylece doğrulayıcı eksik alanı görebilir ve
   * değer ekleyebilir.
   */
  const orphanNames = [...new Set(values.map((value) => value.name))].filter((name) => !profile.byCode.has(name));
  const fieldGroups = [
    ...profile.fields.map((definition) => ({
      name: definition.fieldCode,
      label: definition.label,
      multiValue: isMultiValueField(definition),
      critical: definition.isCritical,
      requirement: definition.requirement,
      required: definition.requirement !== "OPTIONAL",
      extractionPolicy: definition.extractionPolicy,
      dataType: definition.dataType,
      formatHint: definition.formatHint,
      vocabularyCode: definition.vocabularyCode,
      enforceVocabulary: definition.enforceVocabulary,
      valueIds: values.filter((value) => value.name === definition.fieldCode).map((value) => value.id),
    })),
    // Profilden düşmüş ama kaydı olan alanlar gizlenmez; salt okunur gösterilir.
    ...orphanNames.map((name) => ({
      name, label: name, multiValue: false, critical: true,
      requirement: "OPTIONAL" as const, required: false,
      extractionPolicy: "NONE" as const, dataType: "TEXT", formatHint: null,
      vocabularyCode: null, enforceVocabulary: false,
      valueIds: values.filter((value) => value.name === name).map((value) => value.id),
    })),
  ];

  return Response.json({
    document: {
      id:row.id, referenceNo:row.reference_no, originalName:row.original_name, mediaType:row.media_type,
      byteSize:row.byte_size, sha256:row.sha256, documentType:row.document_type, unit:row.unit,
      status:row.status, uploadedBy:row.uploaded_by, createdAt:row.created_at, updatedAt:row.updated_at,
      fileUrl:`/api/documents/${id}/file`,
    },
    profile: {
      code: profile.code, name: profile.name, version: profile.profileVersion,
      status: profile.profileStatus, ownerDepartment: profile.ownerDepartment,
      recordedVersion: row.document_profile_version,
    },
    vocabularies,
    pages: pages.results.map((page) => ({ pageNumber:page.page_number, width:page.width, height:page.height, rawText:page.raw_text, fullText:page.full_text, searchText:page.search_text, confirmedText:page.confirmed_text, confirmedBy:page.confirmed_by, confirmedAt:page.confirmed_at, words:JSON.parse(page.words_json), averageConfidence:page.average_confidence, model:page.model })),
    fields: values,
    fieldGroups,
    relations,
    objects: objects.results.map((object) => ({
      id:object.id, objectClass:object.object_class, mediaType:object.media_type,
      byteSize:object.byte_size, sha256:object.sha256,
      retentionStatus:object.retention_status, legalHoldStatus:object.legal_hold_status,
      generator:object.generator, derivedFromId:object.derived_from_id, createdAt:object.created_at,
    })),
    audit: audit.results.map((event) => ({ eventNumber:event.event_number, actor:event.actor, action:event.action, details:JSON.parse(event.details_json), previousHash:event.previous_hash, eventHash:event.event_hash, createdAt:event.created_at })),
  });
}
