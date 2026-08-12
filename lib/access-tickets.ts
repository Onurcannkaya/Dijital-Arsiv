/**
 * F1.9 / ADR-015 — Tek kullanımlık erişim bileti ve süreli görüntüleme oturumu.
 *
 * Açık kimlik bilgisi yalnız standart Authorization başlığında taşınır; URL,
 * veritabanı, log veya denetim kanıtına yazılmaz. VIEW yalnız erişim türevi,
 * DOWNLOAD yalnız değişmez asıl nesne için geçerlidir. Amaç serbest metin değil
 * kapalı koddur; böylece denetim kanıtına kişisel veri taşınmaz.
 */

import { prepareAuditEvent } from "./audit.ts";
import { digestToHex } from "./content-hasher.ts";

export const ACCESS_TICKET_TTL_SECONDS = 60;
export const ACCESS_SESSION_IDLE_MS = 15 * 60 * 1000;
export const ACCESS_SESSION_ABSOLUTE_MS = 30 * 60 * 1000;

export type AccessScope = "VIEW" | "DOWNLOAD";
export type AccessPurpose = "DOCUMENT_REVIEW" | "ORIGINAL_DOWNLOAD";
export type AccessDenialCode = "TICKET_INVALID" | "SESSION_INVALID";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class AccessTicketError extends Error {
  readonly code: AccessDenialCode;

  constructor(code: AccessDenialCode) {
    super("Erişim bileti veya oturumu geçersiz.");
    this.name = "AccessTicketError";
    this.code = code;
  }
}

export function purposeForScope(scope: AccessScope): AccessPurpose {
  return scope === "VIEW" ? "DOCUMENT_REVIEW" : "ORIGINAL_DOWNLOAD";
}

/** 256 bit rastgele, URL-güvenli opak token. */
export function generateAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function requireToken(token: string, code: AccessDenialCode) {
  if (!TOKEN_PATTERN.test(token)) throw new AccessTicketError(code);
  return token;
}

export async function hashAccessToken(token: string): Promise<string> {
  return digestToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

type Clocked = { now?: () => Date };
function nowOf(options: Clocked) { return options.now?.() ?? new Date(); }

export type IssueTicketInput = Clocked & {
  userId: string;
  documentId: string;
  binaryObjectId: string;
  scope: AccessScope;
  purpose: AccessPurpose;
  ticketId?: string;
  token?: string;
};

type TicketObject = {
  id: string;
  document_id: string;
  object_class: string;
  bucket_or_namespace: string;
};

/** Bilet kaydı ve değiştirilemez denetim olayı tek D1 batch'inde yazılır. */
export async function issueAccessTicket(db: D1Database, input: IssueTicketInput) {
  if (input.purpose !== purposeForScope(input.scope)) {
    throw new Error("Erişim amacı kapsamla uyuşmuyor.");
  }
  const expectedClass = input.scope === "VIEW" ? "access" : "original";
  const expectedNamespace = input.scope === "VIEW" ? "DERIVATIVE_FILES" : "ARCHIVE_FILES";
  const object = await db.prepare(`SELECT id, document_id, object_class, bucket_or_namespace
    FROM binary_objects WHERE id = ? AND document_id = ? AND object_class = ?
      AND bucket_or_namespace = ? AND retention_status <> 'DISPOSED'`)
    .bind(input.binaryObjectId, input.documentId, expectedClass, expectedNamespace)
    .first<TicketObject>();
  if (!object) throw new Error("Erişim kapsamına uygun yetkili nesne bulunamadı.");

  const token = requireToken(input.token ?? generateAccessToken(), "TICKET_INVALID");
  const ticketId = input.ticketId ?? crypto.randomUUID();
  const now = nowOf(input);
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ACCESS_TICKET_TTL_SECONDS * 1000).toISOString();
  const ticketHash = await hashAccessToken(token);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const audit = await prepareAuditEvent(db, {
      documentId: input.documentId,
      actor: input.userId,
      action: "document.ticket-issued",
      details: { ticketId, scope: input.scope, purpose: input.purpose, objectClass: object.object_class },
    });
    try {
      const results = await db.batch([
        db.prepare(`INSERT INTO access_tickets
          (id, ticket_hash, user_id, document_id, binary_object_id, object_class,
           scope, purpose, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(ticketId, ticketHash, input.userId, input.documentId, input.binaryObjectId,
            object.object_class, input.scope, input.purpose, expiresAt, nowIso),
        audit.statement,
      ]);
      if (!results.every((result) => Boolean(result.meta.changes))) {
        throw new Error("Erişim bileti atomik olarak oluşturulamadı.");
      }
      return { ticketId, token, expiresAt, scope: input.scope, purpose: input.purpose };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Erişim bileti oluşturulamadı.");
}

export type ExchangeInput = Clocked & {
  token: string;
  userId: string;
  documentId: string;
  sessionId?: string;
  sessionToken?: string;
};

type ConsumedTicket = {
  id: string;
  binary_object_id: string;
  purpose: AccessPurpose;
  object_class: string;
  bucket_or_namespace: string;
  object_key: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  page_start: number | null;
  page_end: number | null;
};

async function consumeDownload(db: D1Database, input: ExchangeInput): Promise<ConsumedTicket> {
  const nowIso = nowOf(input).toISOString();
  const tokenHash = await hashAccessToken(requireToken(input.token, "TICKET_INVALID"));
  const consumed = await db.prepare(`UPDATE access_tickets SET consumed_at = ?
    WHERE ticket_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL
      AND scope = 'DOWNLOAD' AND purpose = 'ORIGINAL_DOWNLOAD' AND object_class = 'original'
      AND user_id = ? AND document_id = ? AND datetime(expires_at) > datetime(?)
      AND EXISTS (SELECT 1 FROM binary_objects o WHERE o.id = access_tickets.binary_object_id
        AND o.document_id = access_tickets.document_id AND o.object_class = 'original'
        AND o.bucket_or_namespace = 'ARCHIVE_FILES' AND o.retention_status <> 'DISPOSED')
    RETURNING id, binary_object_id, purpose, object_class`)
    .bind(nowIso, tokenHash, input.userId, input.documentId, nowIso)
    .first<Pick<ConsumedTicket, "id" | "binary_object_id" | "purpose" | "object_class">>();
  if (!consumed) throw new AccessTicketError("TICKET_INVALID");
  const object = await db.prepare(`SELECT bucket_or_namespace, object_key, media_type,
      byte_size, sha256, page_start, page_end
    FROM binary_objects WHERE id = ? AND document_id = ? AND object_class = 'original'
      AND bucket_or_namespace = 'ARCHIVE_FILES' AND retention_status <> 'DISPOSED'`)
    .bind(consumed.binary_object_id, input.documentId)
    .first<Omit<ConsumedTicket, "id" | "binary_object_id" | "purpose" | "object_class">>();
  if (!object) throw new AccessTicketError("TICKET_INVALID");
  return { ...consumed, ...object };
}

/** DOWNLOAD bileti tek seferliktir ve görüntüleme oturumu üretmez. */
export async function consumeDownloadTicket(db: D1Database, input: ExchangeInput) {
  return await consumeDownload(db, input);
}

export type ViewSession = {
  sessionId: string;
  token: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
};

/** VIEW bileti tüketimi ile oturum oluşturma aynı atomik batch içindedir. */
export async function exchangeViewTicket(db: D1Database, input: ExchangeInput) {
  const ticketHash = await hashAccessToken(requireToken(input.token, "TICKET_INVALID"));
  const now = nowOf(input);
  const nowIso = now.toISOString();
  const token = requireToken(input.sessionToken ?? generateAccessToken(), "SESSION_INVALID");
  const sessionId = input.sessionId ?? crypto.randomUUID();
  const sessionHash = await hashAccessToken(token);
  const absoluteExpiresAt = new Date(now.getTime() + ACCESS_SESSION_ABSOLUTE_MS).toISOString();
  const idleExpiresAt = new Date(now.getTime() + ACCESS_SESSION_IDLE_MS).toISOString();

  try {
    const results = await db.batch([
      db.prepare(`UPDATE access_tickets SET consumed_at = ?
        WHERE ticket_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL
          AND scope = 'VIEW' AND purpose = 'DOCUMENT_REVIEW' AND object_class = 'access'
          AND user_id = ? AND document_id = ? AND datetime(expires_at) > datetime(?)
          AND EXISTS (SELECT 1 FROM binary_objects o WHERE o.id = access_tickets.binary_object_id
            AND o.document_id = access_tickets.document_id AND o.object_class = 'access'
            AND o.bucket_or_namespace = 'DERIVATIVE_FILES' AND o.retention_status <> 'DISPOSED')`)
        .bind(nowIso, ticketHash, input.userId, input.documentId, nowIso),
      db.prepare(`INSERT INTO access_sessions
          (id, session_hash, access_ticket_id, user_id, document_id, binary_object_id,
           object_class, purpose, idle_expires_at, absolute_expires_at, last_used_at, created_at)
        SELECT ?, ?, t.id, t.user_id, t.document_id, t.binary_object_id,
          t.object_class, t.purpose, ?, ?, ?, ?
        FROM access_tickets t JOIN binary_objects o ON o.id = t.binary_object_id
        WHERE t.ticket_hash = ? AND t.consumed_at = ? AND t.scope = 'VIEW'
          AND t.user_id = ? AND t.document_id = ? AND t.object_class = 'access'
          AND o.document_id = t.document_id AND o.object_class = 'access'
          AND o.bucket_or_namespace = 'DERIVATIVE_FILES' AND o.retention_status <> 'DISPOSED'`)
        .bind(sessionId, sessionHash, idleExpiresAt, absoluteExpiresAt, nowIso, nowIso,
          ticketHash, nowIso, input.userId, input.documentId),
    ]);
    if (results.some((result) => Number(result.meta.changes) !== 1)) {
      throw new AccessTicketError("TICKET_INVALID");
    }
  } catch (error) {
    if (error instanceof AccessTicketError) throw error;
    throw new AccessTicketError("TICKET_INVALID");
  }

  const ticket = await db.prepare(`SELECT t.id, t.binary_object_id, t.purpose, t.object_class,
      o.bucket_or_namespace, o.object_key, o.media_type, o.byte_size, o.sha256, o.page_start, o.page_end
    FROM access_tickets t JOIN binary_objects o ON o.id = t.binary_object_id
    WHERE t.id = ? AND t.document_id = ? AND o.object_class = 'access'
      AND o.bucket_or_namespace = 'DERIVATIVE_FILES' AND o.retention_status <> 'DISPOSED'`)
    .bind((await db.prepare("SELECT access_ticket_id FROM access_sessions WHERE id = ?")
      .bind(sessionId).first<{ access_ticket_id: string }>())?.access_ticket_id ?? "", input.documentId)
    .first<ConsumedTicket>();
  if (!ticket) {
    await revokeViewSession(db, sessionId, now);
    throw new AccessTicketError("TICKET_INVALID");
  }
  const session: ViewSession = { sessionId, token, idleExpiresAt, absoluteExpiresAt };
  return { ticket, session };
}

export type TouchSessionInput = Clocked & { token: string; userId: string; documentId: string };

type ActiveSession = Omit<ConsumedTicket, "id"> & {
  id: string;
  idle_expires_at: string;
  absolute_expires_at: string;
};

export async function touchViewSession(db: D1Database, input: TouchSessionInput): Promise<ActiveSession> {
  const now = nowOf(input);
  const nowIso = now.toISOString();
  const nextIdle = new Date(now.getTime() + ACCESS_SESSION_IDLE_MS).toISOString();
  const sessionHash = await hashAccessToken(requireToken(input.token, "SESSION_INVALID"));
  const session = await db.prepare(`UPDATE access_sessions
    SET last_used_at = ?, idle_expires_at = CASE
      WHEN datetime(?) < datetime(absolute_expires_at) THEN ? ELSE absolute_expires_at END
    WHERE session_hash = ? AND revoked_at IS NULL AND user_id = ? AND document_id = ?
      AND object_class = 'access' AND purpose = 'DOCUMENT_REVIEW'
      AND datetime(idle_expires_at) > datetime(?) AND datetime(absolute_expires_at) > datetime(?)
      AND EXISTS (SELECT 1 FROM binary_objects o WHERE o.id = access_sessions.binary_object_id
        AND o.document_id = access_sessions.document_id AND o.object_class = 'access'
        AND o.bucket_or_namespace = 'DERIVATIVE_FILES' AND o.retention_status <> 'DISPOSED')
    RETURNING id, binary_object_id, object_class, purpose, idle_expires_at, absolute_expires_at`)
    .bind(nowIso, nextIdle, nextIdle, sessionHash, input.userId, input.documentId, nowIso, nowIso)
    .first<Omit<ActiveSession, "bucket_or_namespace" | "object_key" | "media_type" | "byte_size" | "sha256" | "page_start" | "page_end">>();
  if (!session) throw new AccessTicketError("SESSION_INVALID");
  const object = await db.prepare(`SELECT bucket_or_namespace, object_key, media_type,
      byte_size, sha256, page_start, page_end
    FROM binary_objects WHERE id = ? AND document_id = ? AND object_class = 'access'
      AND bucket_or_namespace = 'DERIVATIVE_FILES' AND retention_status <> 'DISPOSED'`)
    .bind(session.binary_object_id, input.documentId)
    .first<Pick<ActiveSession, "bucket_or_namespace" | "object_key" | "media_type" | "byte_size" | "sha256" | "page_start" | "page_end">>();
  if (!object) throw new AccessTicketError("SESSION_INVALID");
  return { ...session, ...object };
}

export async function revokeViewSession(db: D1Database, sessionId: string, now = new Date()) {
  await db.prepare(`UPDATE access_sessions SET revoked_at = COALESCE(revoked_at, ?)
    WHERE id = ?`).bind(now.toISOString(), sessionId).run();
}