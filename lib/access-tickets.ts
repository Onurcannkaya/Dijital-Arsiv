/**
 * F1.9 / ADR-015 — Tek kullanımlık erişim bileti ve süreli görüntüleme oturumu.
 *
 * Uygulama sağlayıcının yeniden kullanılabilir ön imzalı URL'sini kullanıcıya
 * vermez. 256 bitlik opak bilet 60 saniye geçerlidir ve bir kez tüketilir;
 * başarılı VIEW değişimi kullanıcı+belge+nesne+amaç kapsamına bağlı, 15 dakika
 * boşta / 30 dakika mutlak süreli bir görüntüleme oturumu üretir. DOWNLOAD
 * bileti oturum üretmez; tek seferlik teslimdir. Veritabanında yalnız SHA-256
 * özeti durur; açık token hiçbir tabloya, log'a veya denetim kanıtına yazılmaz.
 *
 * Bütün red durumları tek sabit kodla döner (`TICKET_INVALID`/`SESSION_INVALID`):
 * süre dolumu, tüketilmişlik, iptal, yanlış kullanıcı/belge/kapsam ayırt
 * edilemez ve bilet varlığı sızdırılmaz.
 */

import { digestToHex } from "./content-hasher.ts";

export const ACCESS_TICKET_TTL_SECONDS = 60;
export const ACCESS_SESSION_IDLE_MS = 15 * 60 * 1000;
export const ACCESS_SESSION_ABSOLUTE_MS = 30 * 60 * 1000;

export type AccessScope = "VIEW" | "DOWNLOAD";

export type AccessDenialCode = "TICKET_INVALID" | "SESSION_INVALID";

export class AccessTicketError extends Error {
  readonly code: AccessDenialCode;

  constructor(code: AccessDenialCode) {
    super("Erişim bileti veya oturumu geçersiz.");
    this.name = "AccessTicketError";
    this.code = code;
  }
}

/** 256 bit rastgele, URL-güvenli opak token. */
export function generateAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hashAccessToken(token: string): Promise<string> {
  return digestToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

type Clocked = { now?: () => Date };

function nowOf(options: Clocked) {
  return options.now?.() ?? new Date();
}

export type IssueTicketInput = Clocked & {
  userId: string;
  binaryObjectId: string;
  scope: AccessScope;
  purpose: string;
  ticketId?: string;
  token?: string;
};

export async function issueAccessTicket(db: D1Database, input: IssueTicketInput) {
  const purpose = input.purpose.trim().slice(0, 120);
  if (!purpose) throw new Error("Erişim bileti amacı zorunludur.");
  const token = input.token ?? generateAccessToken();
  const ticketId = input.ticketId ?? crypto.randomUUID();
  const now = nowOf(input);
  const expiresAt = new Date(now.getTime() + ACCESS_TICKET_TTL_SECONDS * 1000).toISOString();
  await db.prepare(`INSERT INTO access_tickets
      (id, ticket_hash, user_id, binary_object_id, scope, purpose, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ticketId, await hashAccessToken(token), input.userId, input.binaryObjectId,
      input.scope, purpose, expiresAt, now.toISOString()).run();
  return { ticketId, token, expiresAt, scope: input.scope, purpose };
}

export type ExchangeInput = Clocked & {
  token: string;
  userId: string;
  documentId: string;
  scope: AccessScope;
  sessionId?: string;
  sessionToken?: string;
};

type ConsumedTicket = {
  id: string;
  binary_object_id: string;
  purpose: string;
  object_class: string;
  bucket_or_namespace: string;
  object_key: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  page_start: number | null;
  page_end: number | null;
};

/**
 * Bileti atomik tüketir. Bütün bağlama koşulları (kullanıcı, belge, kapsam,
 * süre, tek kullanım, iptal) tek UPDATE içindedir; koşul sağlanmazsa satır
 * değişmez ve tek tip redde düşülür.
 */
async function consumeTicket(db: D1Database, input: ExchangeInput): Promise<ConsumedTicket> {
  const nowIso = nowOf(input).toISOString();
  const consumed = await db.prepare(`UPDATE access_tickets
    SET consumed_at = ?
    WHERE ticket_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL
      AND scope = ? AND user_id = ?
      AND datetime(expires_at) > datetime(?)
      AND binary_object_id IN (
        SELECT id FROM binary_objects
        WHERE document_id = ? AND retention_status <> 'DISPOSED'
      )
    RETURNING id, binary_object_id, purpose`)
    .bind(nowIso, await hashAccessToken(input.token), input.scope, input.userId,
      nowIso, input.documentId).first<{ id: string; binary_object_id: string; purpose: string }>();
  if (!consumed) throw new AccessTicketError("TICKET_INVALID");
  const object = await db.prepare(`SELECT object_class, bucket_or_namespace, object_key,
      media_type, byte_size, sha256, page_start, page_end
    FROM binary_objects WHERE id = ?`).bind(consumed.binary_object_id)
    .first<Omit<ConsumedTicket, "id" | "binary_object_id" | "purpose">>();
  if (!object) throw new AccessTicketError("TICKET_INVALID");
  return { ...consumed, ...object };
}

/** DOWNLOAD bileti: tek seferlik teslim; oturum üretmez. */
export async function consumeDownloadTicket(db: D1Database, input: ExchangeInput) {
  return await consumeTicket(db, { ...input, scope: "DOWNLOAD" });
}

export type ViewSession = {
  sessionId: string;
  token: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
};

/** VIEW bileti değişimi: bilet tüketilir ve süreli görüntüleme oturumu açılır. */
export async function exchangeViewTicket(db: D1Database, input: ExchangeInput) {
  const ticket = await consumeTicket(db, { ...input, scope: "VIEW" });
  const now = nowOf(input);
  const token = input.sessionToken ?? generateAccessToken();
  const sessionId = input.sessionId ?? crypto.randomUUID();
  const absoluteExpiresAt = new Date(now.getTime() + ACCESS_SESSION_ABSOLUTE_MS).toISOString();
  const idleExpiresAt = new Date(now.getTime() + ACCESS_SESSION_IDLE_MS).toISOString();
  await db.prepare(`INSERT INTO access_sessions
      (id, session_hash, access_ticket_id, user_id, document_id, binary_object_id,
       object_class, purpose, idle_expires_at, absolute_expires_at, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(sessionId, await hashAccessToken(token), ticket.id, input.userId, input.documentId,
      ticket.binary_object_id, ticket.object_class, ticket.purpose,
      idleExpiresAt, absoluteExpiresAt, now.toISOString(), now.toISOString()).run();
  const session: ViewSession = { sessionId, token, idleExpiresAt, absoluteExpiresAt };
  return { ticket, session };
}

export type TouchSessionInput = Clocked & {
  token: string;
  userId: string;
  documentId: string;
};

type ActiveSession = {
  id: string;
  binary_object_id: string;
  object_class: string;
  purpose: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  object_key: string;
  bucket_or_namespace: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  page_start: number | null;
  page_end: number | null;
};

/**
 * Oturumu doğrular ve boşta kalma penceresini atomik ilerletir. Boşta kalma
 * mutlak süreyi asla aşamaz; süresi geçmiş, iptal edilmiş veya başka
 * kullanıcı/belgeye ait oturum tek tip redde düşer.
 */
export async function touchViewSession(db: D1Database, input: TouchSessionInput): Promise<ActiveSession> {
  const now = nowOf(input);
  const nowIso = now.toISOString();
  const nextIdle = new Date(now.getTime() + ACCESS_SESSION_IDLE_MS).toISOString();
  const session = await db.prepare(`UPDATE access_sessions
    SET last_used_at = ?,
        idle_expires_at = CASE WHEN datetime(?) < datetime(absolute_expires_at)
          THEN ? ELSE absolute_expires_at END
    WHERE session_hash = ? AND revoked_at IS NULL
      AND user_id = ? AND document_id = ?
      AND datetime(idle_expires_at) > datetime(?)
      AND datetime(absolute_expires_at) > datetime(?)
    RETURNING id, binary_object_id, object_class, purpose, idle_expires_at, absolute_expires_at`)
    .bind(nowIso, nextIdle, nextIdle, await hashAccessToken(input.token),
      input.userId, input.documentId, nowIso, nowIso)
    .first<Omit<ActiveSession, "object_key" | "bucket_or_namespace" | "media_type" | "byte_size" | "sha256" | "page_start" | "page_end">>();
  if (!session) throw new AccessTicketError("SESSION_INVALID");
  const object = await db.prepare(`SELECT object_key, bucket_or_namespace, media_type,
      byte_size, sha256, page_start, page_end
    FROM binary_objects WHERE id = ? AND retention_status <> 'DISPOSED'`)
    .bind(session.binary_object_id)
    .first<Pick<ActiveSession, "object_key" | "bucket_or_namespace" | "media_type" | "byte_size" | "sha256" | "page_start" | "page_end">>();
  if (!object) throw new AccessTicketError("SESSION_INVALID");
  return { ...session, ...object };
}
