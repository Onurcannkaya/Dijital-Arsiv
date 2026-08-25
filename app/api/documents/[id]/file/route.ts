import { writeAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import {
  AccessTicketError, consumeDownloadTicket, exchangeViewTicket,
  getArchiveBindings, getDerivativeViewReader, getOriginalDownloadReader,
  jsonError, requireArchiveSchema, revokeViewSession, touchViewSession,
  type AccessScope, type ViewSession,
} from "../../../../../lib/archive-storage";
import { logEvent } from "../../../../../lib/observability";
import { contentDisposition } from "../../../../../lib/content-disposition";

type RouteContext = { params: Promise<{ id: string }> };
type FileRecord = { original_name: string; unit: string };
type Credential = { kind: "TICKET" | "SESSION"; token: string };

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

function accessCredential(request: Request): Credential | null {
  const value = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Archive(Ticket|Session) ([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  return { kind: match[1] === "Ticket" ? "TICKET" : "SESSION", token: match[2] };
}

/**
 * Açık bilet/oturum yalnız Authorization başlığında taşınır. VIEW yalnız türev,
 * DOWNLOAD yalnız asıl okuma rolüne ulaşabilir; URL kimlik bilgisi kabul edilmez.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;

  const url = new URL(request.url);
  const credential = accessCredential(request);
  const declaredScope = request.headers.get("x-archive-access-scope");
  const scope: AccessScope | null = declaredScope === "VIEW" || declaredScope === "DOWNLOAD"
    ? declaredScope : null;
  const isDownload = credential?.kind === "TICKET" && scope === "DOWNLOAD";
  const principal = await authorizeRequest(request, bindings.DB,
    isDownload ? "document.download" : "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;

  const record = await bindings.DB.prepare(
    "SELECT original_name, unit FROM archive_documents WHERE id = ?",
  ).bind(id).first<FileRecord>();
  if (!record) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, record.unit)) {
    return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  }

  const denied = async (code: string) => {
    try {
      await writeAuditEvent(bindings.DB, {
        documentId: id,
        actor: principal.email,
        action: "document.access-denied",
        details: { reason: code },
      });
    } catch {
      logEvent("error", "document.access-denied-audit-failed", { documentId: id });
    }
    return jsonError("Erişim bileti veya oturumu geçersiz.", 403);
  };

  // Kimlik bilgisini URL'ye koyan eski/tehlikeli istemciler açıkça reddedilir.
  if (url.searchParams.has("ticket") || url.searchParams.has("session")) {
    return await denied("URL_CREDENTIAL_REJECTED");
  }
  if (!credential || !scope || (credential.kind === "SESSION" && scope !== "VIEW")) {
    return await denied("CREDENTIAL_REQUIRED");
  }

  let servable: ServableObject;
  let session: ViewSession | null = null;
  try {
    if (credential.kind === "SESSION") {
      const active = await touchViewSession(bindings.DB, {
        token: credential.token, userId: principal.email, documentId: id,
      });
      servable = { ...active, binary_object_id: active.binary_object_id };
    } else if (scope === "DOWNLOAD") {
      const consumed = await consumeDownloadTicket(bindings.DB, {
        token: credential.token, userId: principal.email, documentId: id,
      });
      servable = { ...consumed, binary_object_id: consumed.binary_object_id };
    } else {
      const exchanged = await exchangeViewTicket(bindings.DB, {
        token: credential.token, userId: principal.email, documentId: id,
      });
      session = exchanged.session;
      servable = { ...exchanged.ticket, binary_object_id: exchanged.ticket.binary_object_id };
    }
  } catch (error) {
    if (error instanceof AccessTicketError) return await denied(error.code);
    throw error;
  }

  const revokeUnreturnedSession = async () => {
    if (session) await revokeViewSession(bindings.DB, session.sessionId).catch(() => undefined);
  };

  const rangeHeader = credential.kind === "SESSION" ? request.headers.get("range") : null;
  let range: { offset: number; length: number } | null = null;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${servable.byte_size}` } });
    }
    const suffix = match[1] ? null : Number(match[2]);
    const start = suffix === null ? Number(match[1]) : Math.max(0, servable.byte_size - suffix);
    const end = match[1] && match[2]
      ? Math.min(Number(match[2]), servable.byte_size - 1) : servable.byte_size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || suffix === 0 || start < 0 || start > end || start >= servable.byte_size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${servable.byte_size}` } });
    }
    range = { offset: start, length: end - start + 1 };
  }

  const correctBinding = isDownload
    ? servable.object_class === "original" && servable.bucket_or_namespace === "ARCHIVE_FILES"
    : servable.object_class === "access" && servable.bucket_or_namespace === "DERIVATIVE_FILES";
  if (!correctBinding) {
    await revokeUnreturnedSession();
    return jsonError("Erişim kapsamı nesne sınıfıyla uyuşmuyor; belge sunulmadı. Durumu işletim ekibine bildirin.", 503);
  }

  let object;
  try {
    const reader = isDownload
      ? getOriginalDownloadReader(bindings)
      : getDerivativeViewReader(bindings);
    object = await reader.get(servable.object_key, range ? { range } : undefined);
  } catch {
    await revokeUnreturnedSession();
    return jsonError("Belge deposuna şu an erişilemiyor. Birkaç dakika sonra yeniden deneyin; sürerse işletim ekibine bildirin.", 503);
  }
  if (!object) {
    await revokeUnreturnedSession();
    return jsonError("Belgenin aslı kasada bulunamadı. Tekrar denemek sonucu değiştirmez; kayıt numarasıyla işletim ekibine bildirin.", 404);
  }
  const rangeMismatch = range && (object.range?.offset !== range.offset
    || object.range?.length !== range.length || object.bodySize !== range.length);
  if (object.size !== servable.byte_size
    || object.contentType !== servable.media_type
    || (!range && object.range !== null)
    || rangeMismatch) {
    await revokeUnreturnedSession();
    return jsonError("Kasadaki dosya, yetkili nesne kaydıyla uyuşmadığı için sunulmadı. Kayıt numarasıyla işletim ekibine bildirin.", 503);
  }

  try {
    await writeAuditEvent(bindings.DB, {
      documentId: id,
      actor: principal.email,
      action: isDownload ? "document.downloaded" : "document.viewed",
      details: {
        servedObjectClass: servable.object_class,
        byteSize: servable.byte_size,
        purpose: servable.purpose,
        sessionId: session?.sessionId ?? null,
        ranged: Boolean(range),
      },
    });
  } catch {
    await revokeUnreturnedSession();
    return jsonError("Erişim denetim kaydı oluşturulamadı; dosya sunulmadı.", 503);
  }

  const bodySize = range ? object.bodySize : object.size;
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers: {
      "content-type": servable.media_type,
      "content-length": String(bodySize),
      ...(range ? { "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${servable.byte_size}` } : {}),
      ...(!isDownload ? { "accept-ranges": "bytes" } : {}),
      "content-disposition": contentDisposition(isDownload ? "attachment" : "inline", record.original_name),
      "cache-control": "no-store, private",
      "pragma": "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-archive-object-class": servable.object_class,
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
