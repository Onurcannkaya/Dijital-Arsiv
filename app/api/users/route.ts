import { authorizeRequest, roleLabel } from "../../../lib/authorization";
import { UNIT_VOCABULARY_CODE } from "../../../lib/archive-seed";
import { getArchiveBindings, jsonError, requireArchiveSchema } from "../../../lib/archive-storage";
import { loadVocabularyTerms } from "../../../lib/document-profile";
import { failure } from "../../../lib/errors";
import {
  ARCHIVE_ROLES, UserDirectoryError, createUser, listUserAdminEvents, listUsers, updateUser,
} from "../../../lib/user-directory";

export const dynamic = "force-dynamic";

/** Kontrollü müdürlük listesi; sözlük yoksa yalnız `*` kapsamı verilebilir. */
async function allowedUnits(db: D1Database): Promise<string[]> {
  const terms = await loadVocabularyTerms(db, UNIT_VOCABULARY_CODE);
  return (terms ?? []).map((term) => term.label);
}

function directoryFailure(error: unknown, request: Request) {
  return error instanceof UserDirectoryError
    ? Response.json({ error: error.message, code: error.code }, { status: error.status })
    : failure(error, "users.manage", "Kullanıcı işlemi tamamlanamadı.", request);
}

export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "users.manage", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const [users, units, events] = await Promise.all([
      listUsers(bindings.DB),
      allowedUnits(bindings.DB),
      listUserAdminEvents(bindings.DB),
    ]);
    return Response.json({
      users: users.map((user) => ({ ...user, roleLabel: roleLabel(user.role) })),
      roles: ARCHIVE_ROLES.map((role) => ({ value: role, label: roleLabel(role) })),
      units,
      events,
      // Ekran, kendi hesabını kilitleyen işlemleri baştan engelleyebilsin.
      currentUser: principal.email,
    }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) {
    return directoryFailure(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "users.manage", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return jsonError("Geçerli bir istek gövdesi gereklidir.");
    const user = await createUser(bindings.DB, {
      actor: principal.email,
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      unit: body.unit,
      allowedUnits: await allowedUnits(bindings.DB),
    });
    return Response.json({ user: { ...user, roleLabel: roleLabel(user.role) } }, { status: 201 });
  } catch (error) {
    return directoryFailure(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "users.manage", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return jsonError("Geçerli bir istek gövdesi gereklidir.");
    const user = await updateUser(bindings.DB, {
      actor: principal.email,
      email: body.email,
      displayName: body.displayName,
      role: body.role,
      unit: body.unit,
      active: body.active,
      allowedUnits: await allowedUnits(bindings.DB),
    });
    return Response.json({ user: { ...user, roleLabel: roleLabel(user.role) } });
  } catch (error) {
    return directoryFailure(error, request);
  }
}
