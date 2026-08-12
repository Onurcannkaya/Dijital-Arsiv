/**
 * Kurum geneli işlem geçmişi (birleşik denetim akışı).
 *
 * İki değişmez kaynağı zaman sırasına göre birleştirir:
 *  - `audit_events`  : belge yaşam döngüsü ve erişim olayları,
 *  - `user_admin_events` : yetki ve rol değişiklikleri.
 *
 * GÜVENLİK SÖZLEŞMESİ. Bu ekran belge listesinin müdürlük kapsamını DELMEZ:
 * kullanıcı yalnız `*` kapsamındaysa bütün belgelerin, değilse yalnız kendi
 * müdürlüğüne ait belgelerin olaylarını görür. Yetki olayları ise yalnız
 * `users.manage` yetkisi olanlara verilir. Ayrıntı alanı (`details_json`)
 * ham gönderilmez; yalnız sabit değerli, kişisel veri taşımayan birkaç alan
 * (erişim reddi nedeni, bilet kapsamı, nesne sınıfı) aktarılır — anahtar,
 * SHA-256, dosya adı gibi değerler dışarıda kalır (T-11 kanıt ölçütü).
 */

const SAFE_DETAIL_KEYS = ["reason", "scope", "purpose", "objectClass", "servedObjectClass"] as const;
const SAFE_DETAIL_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;

export type ActivityKind = "document" | "user";

export type ActivityEntry = {
  id: string;
  kind: ActivityKind;
  action: string;
  actor: string;
  createdAt: string;
  /** Belge olaylarında dolu; ekran belgeye buradan gider. */
  documentId: string | null;
  referenceNo: string | null;
  unit: string | null;
  /** Yetki olaylarında dolu. */
  targetEmail: string | null;
  roleChange: { from: string | null; to: string } | null;
  accessChange: { from: boolean | null; to: boolean } | null;
  details: Record<string, string>;
};

export type ActivityPage = { entries: ActivityEntry[]; nextCursor: string | null };

export type ActivityQuery = {
  /** Kullanıcının müdürlük kapsamı; `*` bütün arşivi görür. */
  unit: string;
  /** Yalnız `users.manage` yetkisi olanlar için true. */
  includeUserEvents: boolean;
  kind?: ActivityKind | "all";
  limit?: number;
  cursor?: string | null;
};

type Row = {
  kind: ActivityKind;
  id: string;
  created_at: string;
  actor: string;
  action: string;
  document_id: string | null;
  reference_no: string | null;
  unit: string | null;
  target_email: string | null;
  details_json: string | null;
  previous_state: string | null;
  new_state: string | null;
};

type UserState = { role: string; unit: string; active: boolean };

export function encodeActivityCursor(entry: { createdAt: string; id: string }) {
  return btoa(`${entry.createdAt}|${entry.id}`);
}

export function decodeActivityCursor(value: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = atob(value).split("|");
    return createdAt && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

/** Ham ayrıntıdan yalnız sabit değerli, güvenli alanları süzer. */
function safeDetails(json: string | null): Record<string, string> {
  if (!json) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return {}; }
  if (!parsed || typeof parsed !== "object") return {};
  const source = parsed as Record<string, unknown>;
  const safe: Record<string, string> = {};
  for (const key of SAFE_DETAIL_KEYS) {
    const value = source[key];
    if (typeof value === "string" && SAFE_DETAIL_VALUE.test(value)) safe[key] = value;
  }
  return safe;
}

function parseState(json: string | null): UserState | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as UserState;
    return parsed && typeof parsed.role === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function toEntry(row: Row): ActivityEntry {
  const previous = parseState(row.previous_state);
  const next = parseState(row.new_state);
  return {
    id: row.id,
    kind: row.kind,
    action: row.action,
    actor: row.actor,
    createdAt: row.created_at,
    documentId: row.document_id,
    referenceNo: row.reference_no,
    unit: row.unit,
    targetEmail: row.target_email,
    roleChange: next ? { from: previous?.role ?? null, to: next.role } : null,
    accessChange: next && previous && previous.active !== next.active
      ? { from: previous.active, to: next.active } : null,
    details: safeDetails(row.details_json),
  };
}

/**
 * Zaman sırasına göre birleşik sayfa döndürür. Sayfalama anahtar kümesiyle
 * yapılır: `(created_at, id)` ikilisi kararlı sıra verir ve yeni olay
 * eklendiğinde sayfa kaymaz.
 */
export async function listActivity(db: D1Database, query: ActivityQuery): Promise<ActivityPage> {
  const limit = Math.min(Math.max(Number.isSafeInteger(query.limit) ? (query.limit as number) : 40, 1), 100);
  const cursor = query.cursor ? decodeActivityCursor(query.cursor) : null;
  const kind = query.kind ?? "all";

  // Anahtar kümesi koşulu her kaynakta kendi tablo takma adıyla kurulur.
  const keysetFor = (alias: string) => (cursor
    ? `AND (${alias}.created_at < ? OR (${alias}.created_at = ? AND ${alias}.id < ?))`
    : "");
  const keysetBindings = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];

  const selects: string[] = [];
  const bindings: unknown[] = [];

  if (kind === "all" || kind === "document") {
    selects.push(`SELECT 'document' AS kind, a.id AS id, a.created_at AS created_at, a.actor AS actor,
        a.action AS action, a.document_id AS document_id, d.reference_no AS reference_no,
        d.unit AS unit, NULL AS target_email, a.details_json AS details_json,
        NULL AS previous_state, NULL AS new_state
      FROM audit_events a INNER JOIN archive_documents d ON d.id = a.document_id
      WHERE (? = '*' OR d.unit = ?) ${keysetFor("a")}`);
    bindings.push(query.unit, query.unit, ...keysetBindings);
  }
  if (query.includeUserEvents && (kind === "all" || kind === "user")) {
    selects.push(`SELECT 'user' AS kind, u.id AS id, u.created_at AS created_at, u.actor AS actor,
        u.action AS action, NULL AS document_id, NULL AS reference_no,
        NULL AS unit, u.target_email AS target_email, NULL AS details_json,
        u.previous_state AS previous_state, u.new_state AS new_state
      FROM user_admin_events u
      WHERE 1 = 1 ${keysetFor("u")}`);
    bindings.push(...keysetBindings);
  }
  if (!selects.length) return { entries: [], nextCursor: null };

  // Bir fazlası istenir: sonraki sayfanın olup olmadığı böyle anlaşılır.
  const sql = `${selects.join(" UNION ALL ")} ORDER BY created_at DESC, id DESC LIMIT ?`;
  const result = await db.prepare(sql).bind(...bindings, limit + 1).all<Row>();
  const rows = result.results ?? [];
  const page = rows.slice(0, limit).map(toEntry);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  return {
    entries: page,
    nextCursor: hasMore && last ? encodeActivityCursor(last) : null,
  };
}
