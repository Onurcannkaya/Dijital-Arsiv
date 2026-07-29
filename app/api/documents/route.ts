import { prepareAuditEvent } from "../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../lib/authorization";
import { ensureArchiveSchema, getArchiveBindings, jsonError } from "../../../lib/archive-storage";
import { DEFAULT_DOCUMENT_TYPE_CODE, UNIT_VOCABULARY_CODE } from "../../../lib/archive-seed";
import { loadProfileByCode, loadProfileByName, loadVocabularyTerms } from "../../../lib/document-profile";
import { escapeLike, normalizeSearch } from "../../../lib/text-search";

export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/tiff"]);
const MISSING_VALUE = "Belirlenmedi";

type DocumentRecord = {
  id:string; reference_no:string; original_name:string; media_type:string; byte_size:number; sha256:string;
  document_type:string; unit:string; status:string; uploaded_by:string; created_at:string;
  neighborhood?:string; ada?:string; parcel?:string; average_confidence?:number; content_match?:number;
  pending_values?:number; verified_relations?:number; suggested_relations?:number;
};

function publicDocument(row: DocumentRecord) {
  return {
    id:row.id, referenceNo:row.reference_no, originalName:row.original_name, mediaType:row.media_type,
    byteSize:row.byte_size, sha256:row.sha256, documentType:row.document_type, unit:row.unit,
    status:row.status, uploadedBy:row.uploaded_by, createdAt:row.created_at,
    neighborhood:row.neighborhood ?? "", ada:row.ada ?? "", parcel:row.parcel ?? "",
    confidence:row.average_confidence ?? 0, contentMatch:Boolean(row.content_match),
    pendingValues:row.pending_values ?? 0,
    verifiedRelations:row.verified_relations ?? 0,
    suggestedRelations:row.suggested_relations ?? 0,
  };
}

function safeFileName(name: string) { return name.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 140) || "belge"; }

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Çok değerli bir alanı liste görünümü için birleştirir.
 *
 * Reddedilen ve doldurulmamış değerler dışarıda kalır. Sıra, tekil indeksin
 * (`document_id`, `field_name`, `value_index`) tarama sırasını izler; bu kolon
 * yalnız gösterim içindir, ilişki verisi `document_entity_relations` tablosudur.
 */
function fieldSummary(name: string, alias: string) {
  return `COALESCE((SELECT group_concat(COALESCE(f.corrected_value, f.field_value), ' / ')
    FROM extracted_fields f
    WHERE f.document_id = d.id AND f.field_name = '${name}'
      AND f.verification_status <> 'REJECTED'
      AND COALESCE(f.corrected_value, f.field_value) <> '${MISSING_VALUE}'), '') AS ${alias}`;
}

const documentSelect = `SELECT d.id, d.reference_no, d.original_name, d.media_type, d.byte_size,
  d.sha256, d.document_type, d.unit, d.status, d.uploaded_by, d.created_at,
  ${fieldSummary("neighborhood", "neighborhood")},
  ${fieldSummary("ada", "ada")},
  ${fieldSummary("parcel", "parcel")},
  COALESCE((SELECT AVG(p.average_confidence) FROM ocr_pages p WHERE p.document_id = d.id), 0) AS average_confidence,
  (SELECT COUNT(*) FROM extracted_fields f WHERE f.document_id = d.id AND f.verification_status = 'SUGGESTED') AS pending_values,
  (SELECT COUNT(*) FROM document_entity_relations r WHERE r.document_id = d.id AND r.verification_status = 'VERIFIED') AS verified_relations,
  (SELECT COUNT(*) FROM document_entity_relations r WHERE r.document_id = d.id AND r.verification_status = 'SUGGESTED') AS suggested_relations`;

export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    await ensureArchiveSchema(bindings.DB);
    const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 160) ?? "";
    const normalizedTokens = normalizeSearch(query).split(/\s+/).filter(Boolean).slice(0, 8);
    const rawTokens = query.split(/\s+/).filter(Boolean).slice(0, 8);
    const contentPattern = normalizedTokens.length ? `%${normalizedTokens.map(escapeLike).join("%")}%` : "";
    const filters = ["(? = '*' OR d.unit = ?)"];
    const bindingsList: unknown[] = [principal.unit, principal.unit];

    normalizedTokens.forEach((normalizedToken, index) => {
      const rawToken = rawTokens[index] ?? normalizedToken;
      const rawPattern = `%${escapeLike(rawToken)}%`;
      const normalizedPattern = `%${escapeLike(normalizedToken)}%`;
      // Alan aramasında bütün değerler taranır; tek değer varsayımı yapılmaz.
      // Varlık etiketleri de aranabilir, böylece parsel ilişkisi kurulan belge
      // ada/parsel metniyle bulunur.
      filters.push(`(d.reference_no LIKE ? ESCAPE '\\' OR d.original_name LIKE ? ESCAPE '\\'
        OR d.document_type LIKE ? ESCAPE '\\' OR d.unit LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM extracted_fields f WHERE f.document_id = d.id
          AND f.verification_status <> 'REJECTED'
          AND (COALESCE(f.corrected_value, f.field_value) LIKE ? ESCAPE '\\' OR COALESCE(f.normalized_value, '') LIKE ? ESCAPE '\\'))
        OR EXISTS (SELECT 1 FROM document_entity_relations r INNER JOIN entities e ON e.id = r.entity_id
          WHERE r.document_id = d.id AND r.verification_status = 'VERIFIED'
          AND (e.display_label LIKE ? ESCAPE '\\' OR COALESCE(e.external_id, '') LIKE ? ESCAPE '\\'))
        OR EXISTS (SELECT 1 FROM ocr_pages p WHERE p.document_id = d.id
          AND (p.full_text LIKE ? ESCAPE '\\' OR p.raw_text LIKE ? ESCAPE '\\' OR p.search_text LIKE ? ESCAPE '\\')))`);
      bindingsList.push(rawPattern, rawPattern, rawPattern, rawPattern, rawPattern, normalizedPattern,
        rawPattern, rawPattern, rawPattern, rawPattern, normalizedPattern);
    });

    const sql = `${documentSelect},
      CASE WHEN ? = '' THEN 0 ELSE EXISTS (SELECT 1 FROM ocr_pages p WHERE p.document_id = d.id AND p.search_text LIKE ? ESCAPE '\\') END AS content_match
      FROM archive_documents d WHERE ${filters.join(" AND ")} ORDER BY d.created_at DESC LIMIT 50`;
    const result = await bindings.DB.prepare(sql).bind(contentPattern, contentPattern, ...bindingsList).all<DocumentRecord>();
    return Response.json({ documents: result.results.map(publicDocument), query });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Belgeler alınamadı.", 500);
  }
}

export async function POST(request: Request) {
  try {
    const bindings = getArchiveBindings();
    await ensureArchiveSchema(bindings.DB);
    const principal = await authorizeRequest(request, bindings.DB, "document.upload", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError("Yüklenecek dosya bulunamadı.");
    if (!ACCEPTED_TYPES.has(file.type)) return jsonError("Yalnızca PDF, JPEG, PNG veya TIFF yüklenebilir.");
    if (file.size === 0) return jsonError("Boş dosya yüklenemez.");
    if (file.size > MAX_FILE_SIZE) return jsonError("Dosya boyutu 25 MB sınırını aşıyor.", 413);
    const requestedType = String(form.get("documentType") || "").trim().slice(0, 120);
    const unit = String(form.get("unit") || MISSING_VALUE).trim().slice(0, 160);
    if (!canAccessUnit(principal, unit)) return jsonError("Bu müdürlük adına belge yükleme yetkiniz bulunmuyor.", 403);

    // Belge türü kontrollü listeden gelir; serbest metin tasnif kabul edilmez.
    const profile = requestedType
      ? await loadProfileByName(bindings.DB, requestedType)
      : await loadProfileByCode(bindings.DB, DEFAULT_DOCUMENT_TYPE_CODE);
    if (!profile) return jsonError("Belge türü yürürlükteki profiller arasında bulunamadı.");
    const documentType = profile.name;

    // Müdürlük de kontrollü listeye bağlıdır (yetki kapsamını belirlediği için zorunlu).
    const unitTerms = await loadVocabularyTerms(bindings.DB, UNIT_VOCABULARY_CODE);
    if (unitTerms && !unitTerms.some((term) => term.label === unit || term.code === unit)) {
      return jsonError("Müdürlük değeri kontrollü listede bulunmuyor.");
    }

    const bytes = await file.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    const duplicate = await bindings.DB.prepare(`SELECT id, reference_no, original_name, media_type, byte_size,
      sha256, document_type, unit, status, uploaded_by, created_at FROM archive_documents WHERE sha256 = ? LIMIT 1`).bind(sha256).first<DocumentRecord>();
    if (duplicate) {
      return canAccessUnit(principal, duplicate.unit)
        ? Response.json({ document:publicDocument(duplicate), duplicate:true }, { status:409 })
        : jsonError("Aynı içeriğe sahip bir belge arşivde zaten bulunuyor.", 409);
    }

    const now = new Date();
    const id = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const objectId = crypto.randomUUID();
    const referenceNo = `ARS-${now.getUTCFullYear()}-${id.slice(0,8).toUpperCase()}`;
    const storageKey = `originals/${now.getUTCFullYear()}/${id}/${safeFileName(file.name)}`;
    await bindings.ARCHIVE_FILES.put(storageKey, bytes, { httpMetadata:{contentType:file.type}, customMetadata:{sha256, originalName:safeFileName(file.name), uploadedBy:principal.email} });
    try {
      const audit = await prepareAuditEvent(bindings.DB, {
        documentId: id,
        actor: principal.email,
        action: "document.received",
        details: {
          referenceNo, sha256, byteSize: file.size, mediaType: file.type, documentType, unit,
          objectClass: "original", profileCode: profile.code, profileVersion: profile.profileVersion,
        },
      });
      await bindings.DB.batch([
        bindings.DB.prepare(`INSERT INTO archive_documents
          (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
           document_type, document_type_id, document_profile_version, unit, status, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`)
          .bind(id, referenceNo, file.name, storageKey, file.type, file.size, sha256,
            documentType, profile.documentTypeId, profile.profileVersion, unit, principal.email),
        // S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §8: nesne kaydı yetkili listedir.
        bindings.DB.prepare(`INSERT INTO binary_objects
          (id, document_id, object_class, object_key, storage_provider, bucket_or_namespace, media_type, byte_size, sha256, generator)
          VALUES (?, ?, 'original', ?, 'r2', 'ARCHIVE_FILES', ?, ?, ?, 'archive-ingest')`)
          .bind(objectId, id, storageKey, file.type, file.size, sha256),
        bindings.DB.prepare(`INSERT INTO processing_jobs (id, document_id, kind, status, attempt, max_attempts, model)
          VALUES (?, ?, 'ocr', 'queued', 0, 3, 'paddleocr-local')`).bind(jobId, id),
        audit.statement,
      ]);
    } catch (error) {
      await bindings.ARCHIVE_FILES.delete(storageKey);
      throw error;
    }
    const created = await bindings.DB.prepare(`SELECT id, reference_no, original_name, media_type, byte_size,
      sha256, document_type, unit, status, uploaded_by, created_at FROM archive_documents WHERE id = ?`).bind(id).first<DocumentRecord>();
    if (!created) throw new Error("Belge kaydı oluşturulamadı.");
    return Response.json({ document:publicDocument(created), job:{id:jobId,status:"queued",model:"paddleocr-local"} }, { status:201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Belge yüklenemedi.", 500);
  }
}
