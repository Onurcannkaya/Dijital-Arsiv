import { authorizeRequest } from "../../../lib/authorization";
import { requireArchiveSchema, getArchiveBindings, jsonError } from "../../../lib/archive-storage";
import { failure } from "../../../lib/errors";
import { escapeLike, normalizeSearch } from "../../../lib/text-search";

export const dynamic = "force-dynamic";

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

/** VERI_SOZLUGU.md §12.1 belge durumları. */
const DOCUMENT_STATUSES = new Set(["queued", "processing", "review", "ready", "archived", "ocr_failed"]);
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

type PageCursor = { createdAt: string; id: string };
type PageRequest = { limit: number; statuses: string[]; cursor: PageCursor | null };

function encodeCursor(cursor: PageCursor) {
  return btoa(`${cursor.createdAt}|${cursor.id}`);
}

function decodeCursor(value: string): PageCursor | null {
  try {
    const [createdAt, id] = atob(value).split("|");
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

/** Sayfalama ve durum süzme girdisini doğrular; hata varsa mesaj döner. */
function readPageRequest(parameters: URLSearchParams): PageRequest | string {
  const rawLimit = parameters.get("limit");
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      return `\`limit\` 1 ile ${MAX_PAGE_LIMIT} arasında bir tam sayı olmalıdır.`;
    }
    limit = parsed;
  }
  const statuses = (parameters.get("status") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = statuses.filter((status) => !DOCUMENT_STATUSES.has(status));
  if (unknown.length) return `Bilinmeyen belge durumu: ${unknown.join(", ")}.`;

  const rawCursor = parameters.get("cursor");
  if (rawCursor === null) return { limit, statuses, cursor: null };
  const cursor = decodeCursor(rawCursor);
  if (!cursor) return "`cursor` değeri geçersiz.";
  return { limit, statuses, cursor };
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
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const parameters = new URL(request.url).searchParams;
    const query = parameters.get("q")?.trim().slice(0, 160) ?? "";
    const page = readPageRequest(parameters);
    if (typeof page === "string") return jsonError(page);
    const normalizedTokens = normalizeSearch(query).split(/\s+/).filter(Boolean).slice(0, 8);
    const rawTokens = query.split(/\s+/).filter(Boolean).slice(0, 8);
    const contentPattern = normalizedTokens.length ? `%${normalizedTokens.map(escapeLike).join("%")}%` : "";

    /*
     * Yalnız noktalama içeren bir sorgu (`...`, `%%`, `--`) normalleştirmede
     * boşalır. O durumda döngü hiç çalışmaz, hiçbir süzgeç eklenmez ve liste
     * SÜZÜLMEMİŞ haliyle döner; arayüz de bunu "sonuç" diye sunar. Memur
     * aradığını bulduğunu sanar, oysa hiçbir şey eşleşmemiştir. Aranabilir
     * karakter yoksa eşleşme de yoktur; sebebi arayüze bildirilir.
     */
    if (query.length > 0 && normalizedTokens.length === 0) {
      return Response.json({
        documents: [],
        query,
        unsearchableQuery: true,
        page: { limit: page.limit, statuses: page.statuses, hasMore: false, nextCursor: null },
      });
    }
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

    // Durum süzmesi sunucuda yapılır: istemcide süzmek, sayfalanmış bir sonuç
    // kümesinde eksik liste üretir ve arşivlenmiş belgenin doğrulama ekranında
    // görünmesine yol açar.
    if (page.statuses.length) {
      filters.push(`d.status IN (${page.statuses.map(() => "?").join(", ")})`);
      bindingsList.push(...page.statuses);
    }
    // Anahtar kümesi sayfalama: `(created_at, id)` ikilisi kararlı sıra verir.
    // OFFSET kullanılmaz; yeni kayıt eklendiğinde sayfa kaymaz.
    if (page.cursor) {
      filters.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
      bindingsList.push(page.cursor.createdAt, page.cursor.createdAt, page.cursor.id);
    }

    const sql = `${documentSelect},
      CASE WHEN ? = '' THEN 0 ELSE EXISTS (SELECT 1 FROM ocr_pages p WHERE p.document_id = d.id AND p.search_text LIKE ? ESCAPE '\\') END AS content_match
      FROM archive_documents d WHERE ${filters.join(" AND ")}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ?`;
    // Bir fazlası istenir: sonraki sayfanın olup olmadığı böyle anlaşılır.
    const result = await bindings.DB.prepare(sql)
      .bind(contentPattern, contentPattern, ...bindingsList, page.limit + 1).all<DocumentRecord>();
    const rows = result.results.slice(0, page.limit);
    const hasMore = result.results.length > page.limit;
    const last = rows[rows.length - 1];
    return Response.json({
      documents: rows.map(publicDocument),
      query,
      page: {
        limit: page.limit,
        statuses: page.statuses,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
      },
    });
  } catch (error) {
    return failure(error, "documents.list", "Belgeler alınamadı.", request);
  }
}

/**
 * F1.3 ile doğrudan asıl yazma kapatıldı. İstemci önce `/api/uploads` kabul
 * oturumunu kullanır; tarama ve terfi tamamlanmadan belge/asıl/OCR kaydı oluşmaz.
 */
export async function POST() {
  return jsonError("Doğrudan belge yükleme kapatıldı; güvenli kabul oturumunu kullanın.", 410);
}
