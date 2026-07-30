import {
  type IngestSessionStatus,
  type OperatorRetryEvidence,
  decideIngestTransition,
} from "./ingest-state-machine.ts";
import { digestToHex } from "./content-hasher.ts";

type SessionHead = { status: IngestSessionStatus; state_version: number };
type EventHead = { event_number: number; event_hash: string };

export type IngestActor = {
  kind: "user" | "operator" | "service";
  id: string;
};

export type IngestTransitionInput = {
  sessionId: string;
  to: IngestSessionStatus;
  actor: IngestActor;
  reason?: string;
  ingestReceiptId?: string;
  retryEvidence?: OperatorRetryEvidence;
  failureCode?: string | null;
  duplicateOfDocumentId?: string | null;
  now?: string;
  eventId?: string;
};

function canonicalEvent(input: {
  sessionId: string;
  eventNumber: number;
  from: IngestSessionStatus;
  to: IngestSessionStatus;
  actor: IngestActor;
  reason: string | null;
  ingestReceiptId: string | null;
  previousHash: string | null;
  createdAt: string;
}) {
  // Alan sırası sözleşmenin parçasıdır. F1.3 olay yazıcısının bütün
  // uygulamaları aynı UTF-8 JSON dizisini özetlemelidir.
  return JSON.stringify({
    sessionId: input.sessionId,
    eventNumber: input.eventNumber,
    from: input.from,
    to: input.to,
    actorKind: input.actor.kind,
    actorId: input.actor.id,
    reason: input.reason,
    ingestReceiptId: input.ingestReceiptId,
    previousHash: input.previousHash,
    createdAt: input.createdAt,
  });
}

async function sha256Text(value: string) {
  return digestToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Durum olayı ve oturum sürümü aynı D1 batch işlemi içinde yazılır.
 *
 * Olay özeti bir önceki olay özetini içerir; `event_number` tekilliği ve
 * `upload_sessions_transition_guard` eşzamanlı iki yazarın yalnız birinin
 * kazanmasını sağlar.
 */
export async function prepareIngestTransition(db: D1Database, input: IngestTransitionInput) {
  const session = await db.prepare(
    "SELECT status, state_version FROM upload_sessions WHERE id = ?",
  ).bind(input.sessionId).first<SessionHead>();
  if (!session) throw new Error("Kabul oturumu bulunamadı.");
  if (session.status === input.to) return { changed: false, status: session.status, stateVersion: session.state_version, statements: [] };

  const decision = decideIngestTransition(session.status, input.to, input.retryEvidence);
  if (!decision.allowed) throw new Error(decision.reason);
  if (!input.actor.id.trim()) throw new Error("Kabul olayı aktörü boş olamaz.");

  const previous = await db.prepare(`SELECT event_number, event_hash FROM upload_session_events
    WHERE upload_session_id = ? ORDER BY event_number DESC LIMIT 1`)
    .bind(input.sessionId).first<EventHead>();
  if ((previous?.event_number ?? 0) !== session.state_version) {
    throw new Error("Kabul olayı zinciri ile oturum sürümü uyuşmuyor.");
  }

  const eventNumber = session.state_version + 1;
  const createdAt = input.now ?? new Date().toISOString();
  const reason = input.reason?.trim() || null;
  const receiptId = input.ingestReceiptId ?? null;
  const eventHash = await sha256Text(canonicalEvent({
    sessionId: input.sessionId,
    eventNumber,
    from: session.status,
    to: input.to,
    actor: input.actor,
    reason,
    ingestReceiptId: receiptId,
    previousHash: previous?.event_hash ?? null,
    createdAt,
  }));

  const statements = [
    db.prepare(`INSERT INTO upload_session_events
      (id, upload_session_id, event_number, from_status, to_status, actor_kind,
       actor_id, reason, ingest_receipt_id, event_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.eventId ?? crypto.randomUUID(), input.sessionId, eventNumber,
        session.status, input.to, input.actor.kind, input.actor.id, reason,
        receiptId, eventHash, createdAt),
    db.prepare(`UPDATE upload_sessions SET status = ?, state_version = ?,
      failure_code = ?, duplicate_of_document_id = COALESCE(?, duplicate_of_document_id),
      operator_retry_reason = CASE WHEN ? = 'FAILED' AND ? = 'PROMOTING' THEN ? ELSE operator_retry_reason END,
      updated_at = ?
      WHERE id = ? AND status = ? AND state_version = ?`)
      .bind(input.to, eventNumber, input.failureCode ?? null,
        input.duplicateOfDocumentId ?? null, session.status, input.to, reason,
        createdAt, input.sessionId, session.status, session.state_version),
  ];
  return { changed: true, status: input.to, stateVersion: eventNumber, eventHash, statements };
}

export async function transitionIngestSession(db: D1Database, input: IngestTransitionInput) {
  const prepared = await prepareIngestTransition(db, input);
  if (!prepared.changed) return prepared;
  await db.batch(prepared.statements);
  return prepared;
}

