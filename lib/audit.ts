type AuditHead = { event_number: number; event_hash: string };

type AuditInput = {
  documentId: string;
  actor: string;
  action: string;
  details: unknown;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareAuditEvent(db: D1Database, input: AuditInput) {
  const head = await db.prepare(`SELECT event_number, event_hash FROM audit_events
    WHERE document_id = ? ORDER BY event_number DESC LIMIT 1`).bind(input.documentId).first<AuditHead>();
  const eventNumber = (head?.event_number ?? 0) + 1;
  const previousHash = head?.event_hash ?? null;
  const createdAt = new Date().toISOString();
  const detailsJson = JSON.stringify(canonicalize(input.details));
  const hashPayload = JSON.stringify({
    documentId: input.documentId,
    eventNumber,
    actor: input.actor,
    action: input.action,
    details: JSON.parse(detailsJson),
    previousHash,
    createdAt,
  });
  const eventHash = await sha256(hashPayload);
  const id = crypto.randomUUID();
  return {
    id,
    eventNumber,
    eventHash,
    statement: db.prepare(`INSERT INTO audit_events
      (id, document_id, event_number, actor, action, details_json, previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.documentId, eventNumber, input.actor, input.action, detailsJson, previousHash, eventHash, createdAt),
  };
}