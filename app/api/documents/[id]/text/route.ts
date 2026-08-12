import { prepareAuditEvent } from "../../../../../lib/audit";
import { authorizeRequest, canAccessUnit } from "../../../../../lib/authorization";
import { requireArchiveSchema, getArchiveBindings, jsonError } from "../../../../../lib/archive-storage";
import { normalizeSearch } from "../../../../../lib/text-search";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type DocumentState = { status: string; unit: string };
type PageState = {
  page_number: number;
  full_text: string;
  confirmed_text: string | null;
};
type SubmittedPage = { pageNumber?: unknown; text?: unknown };

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const bindings = getArchiveBindings();
  const schemaError = await requireArchiveSchema(request, bindings.DB);
  if (schemaError) return schemaError;
  const principal = await authorizeRequest(request, bindings.DB, "document.review", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  const DB = bindings.DB;

  let body: { pages?: SubmittedPage[] };
  try {
    body = await request.json() as { pages?: SubmittedPage[] };
  } catch {
    return jsonError("Geçerli bir metin sayfası listesi gönderilmelidir.");
  }
  if (!Array.isArray(body.pages) || body.pages.length === 0 || body.pages.length > 250) {
    return jsonError("En az bir, en fazla 250 metin sayfası gönderilebilir.");
  }

  const submitted = body.pages.map((page) => ({
    pageNumber: typeof page.pageNumber === "number" && Number.isInteger(page.pageNumber) ? page.pageNumber : 0,
    text: typeof page.text === "string" ? page.text.replace(/\r\n?/g, "\n").trim() : "",
  }));
  if (submitted.some((page) => page.pageNumber < 1 || !page.text || page.text.length > 250_000)) {
    return jsonError("Sayfa numarası veya onaylı metin geçersiz.");
  }
  if (submitted.reduce((total, page) => total + page.text.length, 0) > 1_000_000) {
    return jsonError("Tek işlemde en fazla 1.000.000 karakter kaydedilebilir.", 413);
  }
  if (new Set(submitted.map((page) => page.pageNumber)).size !== submitted.length) {
    return jsonError("Aynı sayfa birden fazla gönderilemez.");
  }

  const document = await DB.prepare("SELECT status, unit FROM archive_documents WHERE id = ?").bind(id).first<DocumentState>();
  if (!document) return jsonError("Belge bulunamadı.", 404);
  if (!canAccessUnit(principal, document.unit)) return jsonError("Bu belge müdürlük kapsamınızın dışında.", 403);
  if (document.status === "archived") return jsonError("Arşivlenmiş belge metni değiştirilemez.", 409);
  if (!new Set(["review", "ready"]).has(document.status)) return jsonError("Belge henüz metin doğrulamasına hazır değil.", 409);

  const stored = await DB.prepare(`SELECT page_number, full_text, confirmed_text FROM ocr_pages
    WHERE document_id = ? ORDER BY page_number`).bind(id).all<PageState>();
  const byPage = new Map(stored.results.map((page) => [page.page_number, page]));
  if (submitted.some((page) => !byPage.has(page.pageNumber))) return jsonError("Belgede bulunmayan bir sayfa gönderildi.");

  const pageChanges = await Promise.all(submitted.map(async (page) => {
    const current = byPage.get(page.pageNumber)!;
    const previousText = current.confirmed_text ?? current.full_text;
    return {
      pageNumber: page.pageNumber,
      text: page.text,
      changed: previousText !== page.text,
      wasPending: current.confirmed_text === null,
      previousSha256: await sha256(previousText),
      textSha256: await sha256(page.text),
    };
  }));
  if (!pageChanges.some((page) => page.changed || page.wasPending)) {
    return jsonError("Onaylı metinde kaydedilecek bir değişiklik bulunmuyor.", 409);
  }

  const action = pageChanges.some((page) => page.changed) ? "text.corrected" : "text.confirmed";
  const audit = await prepareAuditEvent(DB, {
    documentId: id,
    actor: principal.email,
    action,
    details: {
      previousStatus: document.status,
      pages: pageChanges.map((page) => ({
        pageNumber: page.pageNumber,
        previousSha256: page.previousSha256,
        textSha256: page.textSha256,
        characterCount: page.text.length,
        changed: page.changed,
      })),
    },
  });

  const statements: D1PreparedStatement[] = [];
  for (const page of pageChanges) {
    statements.push(DB.prepare(`INSERT INTO text_revisions
      (id, document_id, page_number, revision_number, previous_sha256, text_sha256, revised_text, actor)
      VALUES (?, ?, ?, COALESCE((SELECT MAX(revision_number) + 1 FROM text_revisions WHERE document_id = ? AND page_number = ?), 1), ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, page.pageNumber, id, page.pageNumber, page.previousSha256, page.textSha256, page.text, principal.email));
    statements.push(DB.prepare(`UPDATE ocr_pages SET confirmed_text = ?, confirmed_by = ?,
      confirmed_at = CURRENT_TIMESTAMP, search_text = ? WHERE document_id = ? AND page_number = ?`)
      .bind(page.text, principal.email, normalizeSearch(page.text), id, page.pageNumber));
  }
  statements.push(DB.prepare("UPDATE archive_documents SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id));
  statements.push(audit.statement);
  await DB.batch(statements);

  return Response.json({
    saved: true,
    documentId: id,
    pages: pageChanges.length,
    action,
    auditEvent: audit.eventNumber,
    eventHash: audit.eventHash,
  });
}
