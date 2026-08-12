import { prepareAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import { requireArchiveSchema, getArchiveBindings, jsonError } from "../../../../../lib/archive-storage";
import {
  FIELD_REJECTION_REASONS, type ValidatedRejection, validateRejection,
} from "../../../../../lib/rejection-reasons";
import { loadProfileByName, loadVocabularyTerms, resolveDocumentProfile, type FieldDefinition } from "../../../../../lib/document-profile";
import {
  MISSING_VALUE, assessRisk, formatViolation, isMultiValueField, vocabularyViolation,
} from "../../../../../lib/field-policy";

export const dynamic = "force-dynamic";

const MAX_OPERATIONS = 60;

type RouteContext = { params: Promise<{ id: string }> };
type DocumentState = { status: string; unit: string; document_type: string; document_type_id: string | null };
type StoredValue = {
  id: string; field_name: string; value_index: number; field_value: string;
  corrected_value: string | null; confidence: number; verification_status: string; origin: string;
};

type ValueAction = "confirm" | "correct" | "reject";
type SubmittedValue = { id?: unknown; action?: unknown; value?: unknown; reasonCode?: unknown; reasonNote?: unknown };
type SubmittedAddition = { fieldName?: unknown; value?: unknown };

type PlannedChange = {
  id: string;
  fieldName: string;
  action: ValueAction | "add";
  from: string | null;
  to: string | null;
  riskLevel: string;
  reason?: string;
  warning?: string;
};

function readValue(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const principal = await authorizeRequest(request, bindings.DB, "document.review", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const DB = bindings.DB;

  let body: { values?: SubmittedValue[]; additions?: SubmittedAddition[] };
  try {
    body = await request.json() as { values?: SubmittedValue[]; additions?: SubmittedAddition[] };
  } catch {
    return jsonError("Geçerli bir doğrulama isteği gönderilmelidir.");
  }
  const submitted = Array.isArray(body.values) ? body.values : [];
  const additions = Array.isArray(body.additions) ? body.additions : [];
  if (!submitted.length && !additions.length) return jsonError("En az bir doğrulama işlemi gönderilmelidir.");
  if (submitted.length + additions.length > MAX_OPERATIONS) return jsonError(`Tek istekte en fazla ${MAX_OPERATIONS} işlem gönderilebilir.`);

  const operations = submitted.map((entry) => ({
    id: typeof entry.id === "string" ? entry.id : "",
    action: entry.action as ValueAction,
    value: readValue(entry.value),
    rejection: entry,
  }));
  if (operations.some((operation) => !operation.id || !["confirm", "correct", "reject"].includes(operation.action))) {
    return jsonError("Her işlem için geçerli bir değer kimliği ve eylem gereklidir.");
  }
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
    return jsonError("Aynı değer birden fazla gönderilemez.");
  }
  /*
   * Ret gerekçesi zorunludur: değişmez izde "kim ve ne zaman" duruyordu ama
   * "neden" durmuyordu. Kontrollü kod, serbest metnin üreteceği raporlanamaz
   * girdileri önler ve OCR'ın hangi alanlarda yanıldığının ölçülmesini sağlar.
   */
  const rejectionByValue = new Map<string, ValidatedRejection>();
  for (const operation of operations) {
    if (operation.action !== "reject") continue;
    const validated = validateRejection(operation.rejection, FIELD_REJECTION_REASONS);
    if (typeof validated === "string") return jsonError(validated);
    rejectionByValue.set(operation.id, validated);
  }

  const document = await DB.prepare(`SELECT status, unit, document_type, document_type_id
    FROM archive_documents WHERE id = ?`).bind(id).first<DocumentState>();
  if (!document) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, document.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  if (document.status === "archived") return jsonError("Arşivlenmiş belge değiştirilemez.", 409);
  if (!new Set(["review", "ready"]).has(document.status)) return jsonError("Belge henüz doğrulamaya hazır değil.", 409);

  // Alan kuralları belge türü profilinden gelir (ADR-008).
  const profile = await resolveDocumentProfile(DB, {
    documentTypeId: document.document_type_id,
    documentType: document.document_type,
  });
  const definitionOf = (fieldCode: string) => profile.byCode.get(fieldCode);
  const labelOf = (fieldCode: string) => definitionOf(fieldCode)?.label ?? fieldCode;

  const newValues = additions.map((entry) => ({
    fieldName: typeof entry.fieldName === "string" ? entry.fieldName.trim() : "",
    value: readValue(entry.value),
  }));
  if (newValues.some((entry) => !definitionOf(entry.fieldName) || !entry.value || entry.value === MISSING_VALUE || entry.value.length > 500)) {
    return jsonError("Eklenen alan bu belge türü profilinde tanımlı değil veya değeri geçersiz.");
  }

  const stored = await DB.prepare(`SELECT id, field_name, value_index, field_value, corrected_value,
    confidence, verification_status, origin FROM extracted_fields WHERE document_id = ?`).bind(id).all<StoredValue>();
  const byId = new Map(stored.results.map((row) => [row.id, row]));
  if (operations.some((operation) => !byId.has(operation.id))) {
    return jsonError("Belgede bulunmayan bir alan değeri gönderildi.");
  }

  // Müdürlük değişikliği kapsam dışına taşınamaz.
  const unitChange = operations.find((operation) => operation.action === "correct" && byId.get(operation.id)!.field_name === "unit");
  if (unitChange && !canAccessUnit(principal, unitChange.value)) {
    return jsonError("Belgeyi müdürlük kapsamınızın dışına taşıyamazsınız.", 403);
  }
  const unitAddition = newValues.find((entry) => entry.fieldName === "unit");
  if (unitAddition && !canAccessUnit(principal, unitAddition.value)) {
    return jsonError("Belgeyi müdürlük kapsamınızın dışına taşıyamazsınız.", 403);
  }

  for (const operation of operations) {
    const current = byId.get(operation.id)!;
    if (operation.action === "correct") {
      if (!operation.value || operation.value === MISSING_VALUE) return jsonError("Düzeltilen değer boş olamaz.");
      if (operation.value.length > 500) return jsonError("Düzeltilen değer çok uzun.");
    }
    // Doldurulmamış bir alan onaylanmış sayılamaz: arşivleme kapısı bunu zaten
    // reddeder, hatayı erken ve anlaşılır biçimde döndürmek daha doğrudur.
    if (operation.action === "confirm" && (current.corrected_value ?? current.field_value) === MISSING_VALUE) {
      return jsonError(`${labelOf(current.field_name)} alanı boş onaylanamaz; değeri girin veya reddedin.`);
    }
    // Tek değerli alanda reddetme değeri boş bırakır; düzeltme kullanılmalıdır.
    if (operation.action === "reject" && !isMultiValueField(definitionOf(current.field_name))) {
      return jsonError(`${labelOf(current.field_name)} tek değerli bir alandır; reddetmek yerine düzeltilmelidir.`);
    }
  }

  const nextIndex = new Map<string, number>();
  for (const row of stored.results) {
    nextIndex.set(row.field_name, Math.max(nextIndex.get(row.field_name) ?? -1, row.value_index));
  }
  const seenAdditions = new Set<string>();
  for (const entry of newValues) {
    if (!isMultiValueField(definitionOf(entry.fieldName))) {
      const active = stored.results.some((row) => row.field_name === entry.fieldName && row.verification_status !== "REJECTED");
      if (active) return jsonError(`${labelOf(entry.fieldName)} tek değerli bir alandır; yeni değer eklenemez.`);
    }
    // Aynı değerin iki kez kaydedilmesi arama ve ilişki kurulumunda gürültü üretir.
    const key = `${entry.fieldName} ${entry.value.toLocaleLowerCase("tr")}`;
    const duplicateStored = stored.results.some((row) =>
      row.field_name === entry.fieldName && row.verification_status !== "REJECTED"
      && (row.corrected_value ?? row.field_value).toLocaleLowerCase("tr") === entry.value.toLocaleLowerCase("tr"));
    if (duplicateStored || seenAdditions.has(key)) {
      return jsonError(`${labelOf(entry.fieldName)} alanında "${entry.value}" değeri zaten kayıtlı.`);
    }
    seenAdditions.add(key);
  }

  /**
   * Kontrollü sözlük denetimi. `enforce_vocabulary` işaretli alanda liste dışı
   * değer reddedilir (müdürlük gibi yetki kapsamını belirleyen alanlar);
   * işaretsiz alanda yalnız uyarı üretilir ve risk yükselir.
   */
  const vocabularyCache = new Map<string, Array<{ code: string; label: string }> | null>();
  const termsFor = async (definition: FieldDefinition | undefined) => {
    if (!definition?.vocabularyCode) return null;
    if (!vocabularyCache.has(definition.vocabularyCode)) {
      vocabularyCache.set(definition.vocabularyCode, await loadVocabularyTerms(DB, definition.vocabularyCode));
    }
    return vocabularyCache.get(definition.vocabularyCode) ?? null;
  };
  const evaluate = async (fieldCode: string, value: string) => {
    const definition = definitionOf(fieldCode);
    const format = formatViolation(definition, value);
    const vocabulary = vocabularyViolation(definition, value, await termsFor(definition));
    if (vocabulary && definition?.enforceVocabulary) {
      return { blocked: vocabulary, warning: null as string | null, definition, violations: [format, vocabulary] };
    }
    return { blocked: null as string | null, warning: format ?? vocabulary, definition, violations: [format, vocabulary] };
  };

  const statements: D1PreparedStatement[] = [];
  const changes: PlannedChange[] = [];

  for (const operation of operations) {
    const current = byId.get(operation.id)!;
    const from = current.corrected_value ?? current.field_value;
    const definition = definitionOf(current.field_name);
    if (operation.action === "confirm") {
      const check = await evaluate(current.field_name, from);
      if (check.blocked) return jsonError(check.blocked);
      const risk = assessRisk({
        definition, value: from, confidence: current.confidence,
        origin: current.origin === "HUMAN" ? "HUMAN" : "OCR", violations: check.violations,
      });
      statements.push(DB.prepare(`UPDATE extracted_fields SET verification_status = 'CONFIRMED',
        verified_by = ?, verified_at = CURRENT_TIMESTAMP, risk_level = ?,
        field_definition_id = COALESCE(field_definition_id, ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND document_id = ?`).bind(principal.email, risk, definition?.id ?? null, operation.id, id));
      changes.push({ id: operation.id, fieldName: current.field_name, action: "confirm", from, to: from, riskLevel: risk, warning: check.warning ?? undefined });
      continue;
    }
    if (operation.action === "reject") {
      statements.push(DB.prepare(`UPDATE extracted_fields SET verification_status = 'REJECTED',
        verified_by = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND document_id = ?`).bind(principal.email, operation.id, id));
      changes.push({ id: operation.id, fieldName: current.field_name, action: "reject", from, to: null,
        riskLevel: "LOW", ...(rejectionByValue.get(operation.id) ?? {}) });
      continue;
    }
    // Personel düzeltmesi: biçim uyarısı işlemi engellemez, riski yükseltir ve
    // yanıtta bildirilir. Belgedeki özgün ifadeyi kaydetmek engellenmemelidir.
    const check = await evaluate(current.field_name, operation.value);
    if (check.blocked) return jsonError(check.blocked);
    const risk = assessRisk({ definition, value: operation.value, confidence: current.confidence, origin: "HUMAN", violations: check.violations });
    statements.push(DB.prepare(`UPDATE extracted_fields SET verification_status = 'CORRECTED',
      corrected_value = ?, corrected_by = ?, corrected_at = CURRENT_TIMESTAMP,
      verified_by = ?, verified_at = CURRENT_TIMESTAMP, risk_level = ?,
      field_definition_id = COALESCE(field_definition_id, ?), updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND document_id = ?`)
      .bind(operation.value, principal.email, principal.email, risk, definition?.id ?? null, operation.id, id));
    changes.push({ id: operation.id, fieldName: current.field_name, action: "correct", from, to: operation.value, riskLevel: risk, warning: check.warning ?? undefined });
  }

  for (const entry of newValues) {
    const check = await evaluate(entry.fieldName, entry.value);
    if (check.blocked) return jsonError(check.blocked);
    const valueIndex = (nextIndex.get(entry.fieldName) ?? -1) + 1;
    nextIndex.set(entry.fieldName, valueIndex);
    const risk = assessRisk({ definition: check.definition, value: entry.value, confidence: 0, origin: "HUMAN", violations: check.violations });
    const newId = crypto.randomUUID();
    statements.push(DB.prepare(`INSERT INTO extracted_fields
      (id, document_id, field_name, field_definition_id, value_index, field_value, normalized_value,
       confidence, risk_level, page_number, bbox_json, evidence_text, model, verification_status,
       origin, verified_by, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, '[0,0,0,0]', ?, 'personel-girisi', 'CONFIRMED', 'HUMAN', ?, CURRENT_TIMESTAMP)`)
      .bind(newId, id, entry.fieldName, check.definition?.id ?? null, valueIndex, entry.value, entry.value, risk,
        `Personel tarafından eklendi: ${principal.displayName}`, principal.email));
    changes.push({ id: newId, fieldName: entry.fieldName, action: "add", from: null, to: entry.value, riskLevel: risk, warning: check.warning ?? undefined });
  }

  /**
   * Belge türü değiştiyse profil bağı da taşınır; aksi hâlde `document_type`
   * metni ile `document_type_id` sessizce ayrışır. Tanınmayan bir tür adı
   * reddedilir: tasnif serbest metne dönmemelidir.
   */
  const typeOperation = operations.find((operation) =>
    byId.get(operation.id)!.field_name === "document_type" && operation.action !== "reject");
  const typeAddition = newValues.find((entry) => entry.fieldName === "document_type");
  const targetTypeName = typeOperation
    ? (typeOperation.action === "correct" ? typeOperation.value : byId.get(typeOperation.id)!.corrected_value ?? byId.get(typeOperation.id)!.field_value)
    : typeAddition?.value ?? null;
  let targetProfile = profile;
  if (targetTypeName && targetTypeName !== profile.name) {
    const resolved = await loadProfileByName(DB, targetTypeName);
    if (!resolved) {
      return jsonError(`"${targetTypeName}" yürürlükteki bir belge türü profili değil; kontrollü listeden bir tür seçin.`);
    }
    targetProfile = resolved;
  }

  changes.sort((left, right) => left.fieldName.localeCompare(right.fieldName) || left.id.localeCompare(right.id));
  const audit = await prepareAuditEvent(DB, {
    documentId: id,
    actor: principal.email,
    action: "fields.confirmed",
    details: {
      previousStatus: document.status, changes,
      profileCode: profile.code, profileVersion: profile.profileVersion,
    },
  });

  // Belge türü ve müdürlük tek değerlidir: reddedilmemiş onaylı değer yansıtılır.
  const singleValueSync = (fieldName: string) => `(SELECT COALESCE(corrected_value, field_value) FROM extracted_fields
    WHERE document_id = ? AND field_name = '${fieldName}' AND verification_status IN ('CONFIRMED', 'CORRECTED')
    ORDER BY value_index LIMIT 1)`;
  statements.push(DB.prepare(`UPDATE archive_documents SET
      document_type = COALESCE(${singleValueSync("document_type")}, document_type),
      unit = COALESCE(${singleValueSync("unit")}, unit),
      document_type_id = ?,
      document_profile_version = ?,
      status = CASE WHEN EXISTS (SELECT 1 FROM extracted_fields WHERE document_id = ? AND verification_status = 'SUGGESTED')
        THEN 'review' ELSE 'ready' END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(id, id, targetProfile.documentTypeId, targetProfile.profileVersion, id, id));
  statements.push(audit.statement);
  await DB.batch(statements);

  return Response.json({
    saved: true,
    documentId: id,
    profile: { code: profile.code, version: profile.profileVersion },
    confirmed: changes.filter((change) => change.action === "confirm").length,
    corrected: changes.filter((change) => change.action === "correct").length,
    rejected: changes.filter((change) => change.action === "reject").length,
    added: changes.filter((change) => change.action === "add").length,
    warnings: changes.filter((change) => change.warning).map((change) => ({ fieldName: change.fieldName, message: change.warning })),
    auditEvent: audit.eventNumber,
  });
}
