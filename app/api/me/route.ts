import { authorizeRequest, roleLabel } from "../../../lib/authorization";
import { ensureArchiveSchema, getArchiveBindings } from "../../../lib/archive-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const bindings = getArchiveBindings();
  await ensureArchiveSchema(bindings.DB);
  const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
  if (principal instanceof Response) return principal;
  return Response.json({ user: { ...principal, roleLabel: roleLabel(principal.role) } });
}