import { writeAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  AccessTicketError, consumeDownloadTicket, exchangeViewTicket,
  getObjectReaderForNamespace, requireArchiveSchema, getArchiveBindings,
  jsonError, touchViewSession, type ViewSession,
} from "../../../../../lib/archive-storage";

type RouteContext = { params: Promise<{ id: string }> };
type FileRecord = { original_name: string; unit: string; reference_no: string };

type ServableObject = {
  binary_object_id: string;
  object_class: string;
  bucket_or_namespace: string;
  object_key: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  page_start: number | null;
  page_end: number | null;
  purpose: string;
};

/**
 * F1.9 / ADR-015 — Belge içeriği yalnız tek kullanımlık bilet veya ondan
 * türeyen görüntüleme oturumuyla sunulur; kalıcı yetkiyle doğrudan indirme
 * yolu kapalıdır.
 *
 * - `?ticket=` (VIEW): bilet tek seferde tüketilir, süreli oturum açılır ve
 *   içerik döner; oturum tokenı yalnız yanıt başlığında görünür.
 * - `?session=` (VIEW): oturum doğrulanır, boşta kalma penceresi ilerletilir
 *   ve `Range` istekleri desteklenir (PDF görüntüleyiciler için).
 * - `?ticket=` (DOWNLOAD): asıl tek seferlik teslim edilir; oturum açılmaz.
 *
 * Bilet/oturum kullanıcı+belge+nesne+amaç kapsamındadır; bütün redler tek tip
 * yanıttır ve denetim kaydına maskeli gerekçeyle yazılır. Sunulan içerik bilet
 * anındaki yetkili nesneye sabitlenir; kuşak değişse bile oturum kendi
 * nesnesini sunar. Denetim yazılamıyorsa içerik sunulmaz.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const url = new URL(request.url);
  const ticketToken = url.searchParams.get("ticket");
  const sessionToken = url.searchParams.get("session");

  // Bilet kullanıcıya bağlıdır: kimliği doğrulanmamış istek bilet çalınsa bile içerik alamaz.
  const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const record = await bindings.DB.prepare(
    "SELECT original_name, unit, reference_no FROM archive_documents WHERE id = ?",
  ).bind(id).first<FileRecord>();
  if (!record) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, record.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);

  const denied = async (code: string) => {
    // Yetki reddi de denetlenir (kanıt rehberi T-05); token asla yazılmaz.
    try {
      await writeAuditEvent(bindings.DB, {
        documentId: id,
        actor: principal.email,
        action: "document.access-denied",
        details: { referenceNo: record.reference_no, reason: code },
      });
    } catch { /* red zaten veriliyor; denetim hatası reddi engellemez */ }
    return jsonError("Erişim bileti veya oturumu geçersiz.", 403);
  };

  let servable: ServableObject;
  let session: ViewSession | null = null;
  let isDownload = false;
  try {
    if (sessionToken) {
      const active = await touchViewSession(bindings.DB, {
        token: sessionToken, userId: principal.email, documentId: id,
      });
      servable = { ...active, binary_object_id: active.binary_object_id };
    } else if (ticketToken) {
      const scope = url.searchParams.get("scope") === "DOWNLOAD" ? "DOWNLOAD" : "VIEW";
      if (scope === "DOWNLOAD") {
        isDownload = true;
        const consumed = await consumeDownloadTicket(bindings.DB, {
          token: ticketToken, userId: principal.email, documentId: id, scope: "DOWNLOAD",
        });
        servable = { ...consumed, binary_object_id: consumed.binary_object_id };
      } else {
        const exchanged = await exchangeViewTicket(bindings.DB, {
          token: ticketToken, userId: principal.email, documentId: id, scope: "VIEW",
        });
        session = exchanged.session;
        servable = { ...exchanged.ticket, binary_object_id: exchanged.ticket.binary_object_id };
      }
    } else {
      return await denied("TICKET_REQUIRED");
    }
  } catch (error) {
    if (error instanceof AccessTicketError) return await denied(error.code);
    throw error;
  }

  // Range yalnız oturum isteklerinde desteklenir; değişim ve indirme tam gövde döner.
  const rangeHeader = sessionToken ? request.headers.get("range") : null;
  let range: { offset: number; length: number } | null = null;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${servable.byte_size}` } });
    }
    const start = match[1] ? Number(match[1]) : servable.byte_size - Number(match[2]);
    const end = match[1] && match[2] ? Math.min(Number(match[2]), servable.byte_size - 1) : servable.byte_size - 1;
    if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= servable.byte_size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${servable.byte_size}` } });
    }
    range = { offset: start, length: end - start + 1 };
  }

  let object;
  try {
    const reader = getObjectReaderForNamespace(bindings, servable.bucket_or_namespace);
    object = await reader.get(servable.object_key, range ? { range } : undefined);
  } catch {
    return jsonError("Belge depolama okuma rolü kullanılamıyor.", 503);
  }
  if (!object) return jsonError("Dosya kasada bulunamadı.", 404);
  if (object.size !== servable.byte_size
    || (object.contentType && object.contentType !== servable.media_type)
    || (!range && object.range !== null)) {
    return jsonError("Dosya kasası kanıtı yetkili nesne kaydıyla uyuşmuyor.", 503);
  }

  try {
    await writeAuditEvent(bindings.DB, {
      documentId: id,
      actor: principal.email,
      action: isDownload ? "document.downloaded" : "document.viewed",
      details: {
        referenceNo: record.reference_no,
        servedObjectClass: servable.object_class,
        sha256: servable.sha256,
        byteSize: servable.byte_size,
        purpose: servable.purpose,
        sessionId: session?.sessionId ?? null,
        ranged: Boolean(range),
      },
    });
  } catch {
    return jsonError("Erişim denetim kaydı oluşturulamadı; dosya sunulmadı.", 503);
  }

  const safeName = record.original_name.replace(/[\r\n"]/g, "_");
  const bodySize = range ? object.bodySize : object.size;
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers: {
      "content-type": servable.media_type,
      "content-length": String(bodySize),
      ...(range ? { "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${servable.byte_size}` } : {}),
      ...(sessionToken || session ? { "accept-ranges": "bytes" } : {}),
      "content-disposition": `${isDownload ? "attachment" : "inline"}; filename="${safeName}"`,
      // Belge içeriği paylaşılan önbelleklere ve tarayıcı diskine yazılmamalıdır.
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "x-archive-object-class": servable.object_class,
      // Değişim yanıtı oturum tokenını bir kez verir; istemci Range için kullanır.
      ...(session ? {
        "x-archive-session": session.token,
        "x-archive-session-idle-expires": session.idleExpiresAt,
        "x-archive-session-absolute-expires": session.absoluteExpiresAt,
      } : {}),
      ...(servable.page_start ? {
        "x-archive-page-start": String(servable.page_start),
        "x-archive-page-end": String(servable.page_end ?? servable.page_start),
      } : {}),
    },
  });
}
