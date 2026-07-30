import { prepareAuditEvent } from "../../../../lib/audit";
import { authorizeRequest } from "../../../../lib/authorization";
import {
  getArchiveBindings, getArchiveObjectStorage, requireArchiveSchema,
  jsonError, localOcrServiceUrl, resolveOriginalObject, type ArchiveBindings,
} from "../../../../lib/archive-storage";
import { DEFAULT_DOCUMENT_TYPE_CODE, UNIT_VOCABULARY_CODE } from "../../../../lib/archive-seed";
import {
  listActiveProfiles, loadVocabularyTerms, loadVocabularyVersion,
  resolveDocumentProfile, type DocumentProfile,
} from "../../../../lib/document-profile";
import { relationStatement, resolveParcelEntity } from "../../../../lib/entities";
import { PublicError, failure, isPublicError } from "../../../../lib/errors";
import { MISSING_VALUE, assessRisk, isMultiValueField, requiredFields } from "../../../../lib/field-policy";
import { ExtractedField, OcrProfilePayload, parseOcrServiceResult } from "../../../../lib/ocr-contract";
import { logEvent } from "../../../../lib/observability";
import { normalizeSearch } from "../../../../lib/text-search";

export const dynamic = "force-dynamic";

type ClaimedJob = { id: string; document_id: string; attempt: number; max_attempts: number };
type SourceDocument = {
  id: string; original_name: string; media_type: string;
  document_type: string; document_type_id: string | null; unit: string;
};

/** Belge türü ve müdürlük için "henüz belirlenmedi" anlamına gelen değerler. */
const UNSET_UNIT = "Belirlenmedi";

type PersistedField = ExtractedField & {
  id: string; valueIndex: number; riskLevel: string; fieldDefinitionId: string | null;
};

async function releaseFailedJob(db: D1Database, job: ClaimedJob, message: string) {
  const status = job.attempt >= job.max_attempts ? "failed" : "queued";
  const backoffSeconds = Math.min(3600, 30 * (2 ** Math.max(0, job.attempt - 1)));
  await db.prepare(`UPDATE processing_jobs SET status = ?, error_message = ?,
      next_attempt_at = CASE WHEN ? = 'queued' THEN datetime('now', ?) ELSE NULL END,
      dead_lettered_at = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(status, message.slice(0, 1000), status, `+${backoffSeconds} seconds`, status, job.id).run();
  await db.prepare("UPDATE archive_documents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(status === "failed" ? "ocr_failed" : "queued", job.document_id).run();
}

/**
 * OCR adaylarını profil kurallarına göre kalıcı alan kayıtlarına dönüştürür.
 *
 * - Profilde tanımlı olmayan alan adı yok sayılır: OCR profil dışına yazamaz.
 * - Çok değerli alanlarda bütün adaylar korunur (VERI_SOZLUGU.md §8).
 * - Tek değerli alanlarda en yüksek güvenli aday seçilir.
 * - Profilde beklenen ama bulunamayan alanlar personel girişine zorlanmak üzere
 *   boş değerle oluşturulur.
 */
function planFields(candidates: ExtractedField[], profile: DocumentProfile): PersistedField[] {
  const byName = new Map<string, ExtractedField[]>();
  for (const candidate of candidates) {
    const definition = profile.byCode.get(candidate.name);
    if (!definition || definition.extractionPolicy === "NONE") continue;
    const list = byName.get(candidate.name) ?? [];
    list.push(candidate);
    byName.set(candidate.name, list);
  }

  const planned: PersistedField[] = [];
  for (const [name, list] of byName) {
    const definition = profile.byCode.get(name);
    const selected = isMultiValueField(definition)
      ? list
      : [[...list].sort((left, right) => right.confidence - left.confidence)[0]];
    selected.forEach((candidate, valueIndex) => {
      planned.push({
        ...candidate,
        id: crypto.randomUUID(),
        valueIndex,
        fieldDefinitionId: definition?.id ?? null,
        riskLevel: assessRisk({ definition, value: candidate.value, confidence: candidate.confidence }),
      });
    });
  }

  for (const definition of requiredFields(profile)) {
    if (planned.some((field) => field.name === definition.fieldCode)) continue;
    planned.push({
      id: crypto.randomUUID(),
      name: definition.fieldCode,
      value: MISSING_VALUE,
      normalizedValue: null,
      confidence: 0,
      pageNumber: 1,
      box: [0, 0, 0, 0],
      evidenceText: "OCR tarafından bulunamadı; personel girişi gerekli",
      group: null,
      valueIndex: 0,
      fieldDefinitionId: definition.id,
      riskLevel: assessRisk({ definition, value: MISSING_VALUE, confidence: 0 }),
    });
  }
  return planned;
}

/** Aynı gruba ait ada/parsel çiftlerini eşleştirir. */
function parcelGroups(fields: PersistedField[]) {
  const groups = new Map<string, { ada?: PersistedField; parcel?: PersistedField }>();
  for (const field of fields) {
    if (!field.group || (field.name !== "ada" && field.name !== "parcel")) continue;
    if (field.value === MISSING_VALUE) continue;
    const group = groups.get(field.group) ?? {};
    if (field.name === "ada") group.ada = field;
    else group.parcel = field;
    groups.set(field.group, group);
  }
  return [...groups.entries()]
    .filter((entry): entry is [string, { ada: PersistedField; parcel: PersistedField }] => Boolean(entry[1].ada && entry[1].parcel));
}

/** Kontrollü sözlükten ve yürürlükteki profillerden OCR isteği için sözlük paketi. */
async function buildOcrProfile(db: D1Database, profile: DocumentProfile): Promise<OcrProfilePayload> {
  const [units, vocabularyVersion, activeProfiles] = await Promise.all([
    loadVocabularyTerms(db, UNIT_VOCABULARY_CODE),
    loadVocabularyVersion(db, UNIT_VOCABULARY_CODE),
    listActiveProfiles(db),
  ]);
  return {
    profileVersion: profile.profileVersion,
    vocabularyVersion,
    units: (units ?? []).map((term) => term.label).filter((label) => label !== UNSET_UNIT),
    documentTypes: activeProfiles
      .filter((entry) => entry.detectionMarkers.length)
      .map((entry) => ({ name: entry.name, markers: entry.detectionMarkers })),
  };
}

export type OcrProcessOptions = {
  actor: string;
  unit: string;
  serviceUrl: string;
  requestedDocumentId?: string | null;
};

/** HTTP ve Cron Trigger tarafından paylaşılan tek OCR işi tüketicisi. */
export async function processNextOcrJob(bindings: ArchiveBindings, options: OcrProcessOptions) {
  const objectStorage = getArchiveObjectStorage(bindings);
  const serviceUrl = options.serviceUrl;
  if (!serviceUrl) throw new PublicError("OCR servis adresi yapılandırılmamış.", 503);
  const requestedDocumentId = options.requestedDocumentId ?? null;
  const job = await bindings.DB.prepare(`UPDATE processing_jobs
    SET status = 'processing', attempt = CASE WHEN status = 'failed' THEN 1 ELSE attempt + 1 END,
        error_message = NULL, next_attempt_at = NULL, last_attempt_at = CURRENT_TIMESTAMP,
        dead_lettered_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT processing_jobs.id FROM processing_jobs
      INNER JOIN archive_documents ON archive_documents.id = processing_jobs.document_id
      WHERE ((processing_jobs.status = 'queued' AND processing_jobs.attempt < processing_jobs.max_attempts
          AND (processing_jobs.next_attempt_at IS NULL OR processing_jobs.next_attempt_at <= CURRENT_TIMESTAMP))
        OR (processing_jobs.status = 'failed' AND ? IS NOT NULL))
        AND (? IS NULL OR processing_jobs.document_id = ?)
        AND (? = '*' OR archive_documents.unit = ?)
      ORDER BY processing_jobs.created_at ASC LIMIT 1
    ) AND status IN ('queued', 'failed')
    RETURNING id, document_id, attempt, max_attempts`).bind(requestedDocumentId, requestedDocumentId, requestedDocumentId, options.unit, options.unit).first<ClaimedJob>();

  if (!job) return { processed: false, message: "Bekleyen OCR işi yok." };

  try {
    const document = await bindings.DB.prepare(`SELECT id, original_name, media_type, document_type,
      document_type_id, unit FROM archive_documents WHERE id = ?`).bind(job.document_id).first<SourceDocument>();
    if (!document) throw new PublicError("OCR işine ait belge bulunamadı.", 502);
    const original = await resolveOriginalObject(bindings.DB, document.id);
    if (!original) throw new PublicError("Belgenin asıl nesne kaydı bulunamadı.", 502);
    const currentProfile = await resolveDocumentProfile(bindings.DB, {
      documentTypeId: document.document_type_id,
      documentType: document.document_type,
    });
    const ocrProfile = await buildOcrProfile(bindings.DB, currentProfile);

    // Belge baytları Worker üzerinden taşınmaz. OCR servisi yalnız nesne
    // referansını alır ve ORIGINAL_FILES için salt-okunur servis kimliğiyle
    // nesneyi kendi geçici diskine akışla indirir (ADR-014/F1.3).
    const headers: HeadersInit = { "content-type": "application/json" };
    if (bindings.OCR_SERVICE_TOKEN) headers.authorization = `Bearer ${bindings.OCR_SERVICE_TOKEN}`;
    const response = await fetch(`${serviceUrl}/v1/ocr`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        documentId: document.id,
        objectKey: original.object_key,
        mediaType: original.media_type,
        byteSize: original.byte_size,
        sha256: original.sha256,
        profile: ocrProfile,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`OCR servisi ${response.status} hatası verdi: ${(await response.text()).slice(0, 300)}`);
    const result = parseOcrServiceResult(await response.json());

    // OCR önerisi yetkili kaynağın üzerine yazmaz (VERI_SOZLUGU.md §3): belge türü
    // ve müdürlük yalnız henüz belirlenmemişse otomatik doldurulur.
    const suggestedTypeName = result.fields.find((field) => field.name === "document_type")?.value ?? null;
    const suggestedUnit = result.fields.find((field) => field.name === "unit")?.value ?? null;
    // Belge hâlâ varsayılan (tasnif edilmemiş) profildeyse tür önerisi uygulanır;
    // tasnifi yapılmış bir belgenin türü OCR tarafından değiştirilmez.
    const isUnclassified = currentProfile.code === DEFAULT_DOCUMENT_TYPE_CODE;
    const detectedProfile = suggestedTypeName && isUnclassified
      ? await resolveDocumentProfile(bindings.DB, { documentType: suggestedTypeName })
      : null;
    // Tespit edilen tür ancak yürürlükteki bir profile karşılık geliyorsa uygulanır.
    const appliedProfile = detectedProfile && detectedProfile.code !== currentProfile.code ? detectedProfile : null;
    const appliedUnit = document.unit === UNSET_UNIT ? suggestedUnit : null;
    const effectiveProfile = appliedProfile ?? currentProfile;
    const fields = planFields(result.fields, effectiveProfile);

    const writeStatements: D1PreparedStatement[] = [
      // Yeniden işlemede OCR'ın kendi önerileri temizlenir; personelin
      // doğruladığı ilişkiler korunur.
      bindings.DB.prepare(`DELETE FROM document_entity_relations
        WHERE document_id = ? AND relation_source = 'OCR' AND verification_status = 'SUGGESTED'`).bind(document.id),
      bindings.DB.prepare("DELETE FROM ocr_pages WHERE document_id = ?").bind(document.id),
      bindings.DB.prepare("DELETE FROM extracted_fields WHERE document_id = ?").bind(document.id),
    ];
    for (const page of result.pages) {
      writeStatements.push(bindings.DB.prepare(`INSERT INTO ocr_pages
        (id, document_id, page_number, width, height, raw_text, full_text, search_text, words_json, average_confidence, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        // Aranabilir biçim burada üretilir: dizin ve sorgu aynı fonksiyondan geçer.
        .bind(crypto.randomUUID(), document.id, page.pageNumber, page.width, page.height, page.rawText,
          page.fullText, normalizeSearch(page.fullText), JSON.stringify(page.words), page.averageConfidence, result.model));
    }
    for (const field of fields) {
      writeStatements.push(bindings.DB.prepare(`INSERT INTO extracted_fields
        (id, document_id, field_name, field_definition_id, value_index, field_value, normalized_value,
         confidence, risk_level, page_number, bbox_json, evidence_text, model, vocabulary_version,
         verification_status, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUGGESTED', 'OCR')`)
        .bind(field.id, document.id, field.name, field.fieldDefinitionId, field.valueIndex, field.value,
          field.normalizedValue ?? null, field.confidence, field.riskLevel, field.pageNumber,
          JSON.stringify(field.box), field.evidenceText, result.model, result.vocabularyVersion));
    }
    await bindings.DB.batch(writeStatements);

    /**
     * Erişim türevi: görüntüleme asıl dosyayı açmasın diye kontrollü kopya
     * yazılır (S3_DEPOLAMA... §5). Depolama yazımı başarısız olursa OCR sonucu
     * korunur; türev sonraki çalıştırmada yeniden üretilir.
     */
    let accessObjectId: string | null = null;
    if (result.accessDerivative) {
      const originalRecord = await bindings.DB.prepare(
        "SELECT id FROM binary_objects WHERE document_id = ? AND object_class = 'original' LIMIT 1",
      ).bind(document.id).first<{ id: string }>();
      const derivativeId = crypto.randomUUID();
      const derivativeKey = `derivatives/${document.id}/access/${derivativeId}`;
      let derivativeStored = false;
      try {
        const bytes = Uint8Array.from(atob(result.accessDerivative.base64), (character) => character.charCodeAt(0));
        if (bytes.byteLength !== result.accessDerivative.byteSize) {
          throw new Error("Erişim türevi beyan edilen boyutla uyuşmuyor.");
        }
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        await objectStorage.put(derivativeKey, bytes, {
          contentType: result.accessDerivative.mediaType,
          customMetadata: { sha256, documentId: document.id, binaryObjectId: derivativeId },
        });
        derivativeStored = true;
        // Türevler sürümlüdür; eski kayıt ve nesneler politika uyarınca korunur.
        await bindings.DB.prepare(`INSERT INTO binary_objects
            (id, document_id, object_class, object_key, storage_provider, bucket_or_namespace,
             media_type, byte_size, sha256, derived_from_id, generator)
            VALUES (?, ?, 'access', ?, 'r2', 'ARCHIVE_FILES', ?, ?, ?, ?, ?)`)
            .bind(derivativeId, document.id, derivativeKey, result.accessDerivative.mediaType,
              bytes.byteLength, sha256, originalRecord?.id ?? null, `ocr:${result.model}`).run();
        accessObjectId = derivativeId;
      } catch (derivativeError) {
        // R2 yazılmış fakat D1 kaydı yazılamamışsa yetkili liste dışında nesne bırakma.
        if (derivativeStored) await objectStorage.delete(derivativeKey).catch(() => undefined);
        logEvent("error", "ocr.access-derivative-failed", {
          documentId: document.id,
          error: derivativeError instanceof Error ? derivativeError.message : String(derivativeError),
        });
      }
    }

    // Alan kayıtları yazıldıktan sonra varlık ilişkileri kurulur: ilişki kaydı
    // kanıt olarak alan satırına yabancı anahtarla bağlanır.
    const groups = parcelGroups(fields);
    const relationStatements: D1PreparedStatement[] = [];
    for (const [group, pair] of groups) {
      // İlçe ve kadastro mahallesi OCR'dan güvenilir biçimde çıkarılamaz; varlık
      // bu nedenle PROVISIONAL kalır ve ilişki TEXT_MENTION/SUGGESTED olur
      // (VERI_SOZLUGU.md §10, ANA_SISTEM_TASARIM_BELGESI.md §7.5).
      const entity = await resolveParcelEntity(bindings.DB, { blockNo: pair.ada.value, parcelNo: pair.parcel.value }, `ocr:${result.model}`);
      relationStatements.push(relationStatement(bindings.DB, {
        documentId: document.id,
        entityId: entity.id,
        relationType: "TEXT_MENTION",
        relationSource: "OCR",
        relationConfidence: Math.min(pair.ada.confidence, pair.parcel.confidence),
        verificationStatus: "SUGGESTED",
        evidence: { group, pageNumber: pair.parcel.pageNumber, box: pair.parcel.box, evidenceText: pair.parcel.evidenceText, model: result.model },
        extractedFieldId: pair.parcel.id,
        actor: `ocr:${result.model}`,
      }));
    }

    const audit = await prepareAuditEvent(bindings.DB, {
      documentId: document.id,
      actor: options.actor,
      action: "ocr.completed",
      details: {
        engine: result.engine, model: result.model, durationMs: result.durationMs,
        pages: result.pages.length, fieldValues: fields.length, suggestedRelations: groups.length,
        profileCode: effectiveProfile.code, profileVersion: effectiveProfile.profileVersion,
        vocabularyVersion: result.vocabularyVersion,
        accessDerivative: accessObjectId ? "created" : "none",
        appliedDocumentType: appliedProfile?.name ?? null, appliedUnit,
      },
    });
    await bindings.DB.batch([
      ...relationStatements,
      bindings.DB.prepare(`UPDATE archive_documents SET status = 'review',
        document_type = COALESCE(?, document_type),
        document_type_id = COALESCE(?, document_type_id),
        document_profile_version = COALESCE(?, document_profile_version),
        unit = COALESCE(?, unit), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(appliedProfile?.name ?? null, appliedProfile?.documentTypeId ?? effectiveProfile.documentTypeId,
          effectiveProfile.profileVersion, appliedUnit, document.id),
      bindings.DB.prepare(`UPDATE processing_jobs SET status = 'completed', model = ?, error_message = NULL,
        next_attempt_at = NULL, dead_lettered_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(result.model, job.id),
      audit.statement,
    ]);

    return {
      processed: true, jobId: job.id, documentId: document.id, engine: result.engine, model: result.model,
      durationMs: result.durationMs, pages: result.pages.length, fieldValues: fields.length,
      suggestedRelations: groups.length, profileCode: effectiveProfile.code,
      profileVersion: effectiveProfile.profileVersion, accessDerivative: Boolean(accessObjectId),
      auditEvent: audit.eventNumber,
    };
  } catch (error) {
    // Ayrıntılı neden her durumda işe kaydedilir; istemciye yalnız işletim
    // hatalarının metni döner, beklenmeyen iç hatalar korelasyon kimliğiyle geçer.
    const detail = error instanceof Error ? error.message : String(error);
    await releaseFailedJob(bindings.DB, job, detail);
    throw error;
  }
}

export async function POST(request: Request) {
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const principal = await authorizeRequest(request, bindings.DB, "ocr.run", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const serviceUrl = localOcrServiceUrl(request, bindings.OCR_SERVICE_URL);
  if (!serviceUrl) return jsonError("OCR servis adresi yapılandırılmamış.", 503);

  try {
    const result = await processNextOcrJob(bindings, {
      actor: principal.email,
      unit: principal.unit,
      serviceUrl,
      requestedDocumentId: new URL(request.url).searchParams.get("documentId"),
    });
    return Response.json(result);
  } catch (error) {
    if (isPublicError(error)) return jsonError(error.message, error.status);
    return failure(error, "ocr.process", "OCR işlemi tamamlanamadı.", request);
  }
}
