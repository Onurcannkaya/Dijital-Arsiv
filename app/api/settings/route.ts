import { authorizeRequest } from "../../../lib/authorization";
import { UNIT_VOCABULARY_CODE } from "../../../lib/archive-seed";
import {
  ARCHIVE_SCHEMA_VERSION, getArchiveBindings, jsonError, readMaintenanceProgress,
  readSchemaVersion, requireArchiveSchema,
} from "../../../lib/archive-storage";
import { failure } from "../../../lib/errors";
import { UnitDirectoryError, createUnit, listUnits, setUnitActive } from "../../../lib/unit-directory";

export const dynamic = "force-dynamic";

/**
 * Kurum ayarları: sistem durumu (salt okunur) ve müdürlük listesi.
 *
 * Bilinçli olarak KAPSAM DIŞI: saklama/tasfiye ayarları (ADR-018 Karar 5 —
 * ilk üretim döneminde tasfiye kapalıdır ve kurul kararı gerektirir), rol-izin
 * matrisi (kurumsal görev ayrılığı kararı, kodda sabittir), depolama/WORM
 * profili (ADR-016, sağlayıcı tarafı) ve servis adresleri/jetonları (dağıtım
 * sırları). Bunlar arayüzden değiştirilemez.
 */

function settingsFailure(error: unknown, request: Request) {
  return error instanceof UnitDirectoryError
    ? Response.json({ error: error.message, code: error.code }, { status: error.status })
    : failure(error, "settings", "Ayarlar işlemi tamamlanamadı.", request);
}

export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "users.manage", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const [units, schemaVersion, maintenance] = await Promise.all([
      listUnits(bindings.DB, UNIT_VOCABULARY_CODE),
      readSchemaVersion(bindings.DB),
      readMaintenanceProgress(bindings.DB),
    ]);
    return Response.json({
      units,
      schema: { version: schemaVersion, expected: ARCHIVE_SCHEMA_VERSION, ok: schemaVersion === ARCHIVE_SCHEMA_VERSION },
      maintenance,
      // Arayüz, değiştirilemeyen alanları neden değiştirilemediğiyle gösterir.
      lockedSettings: [
        { key: "retention", label: "Saklama ve tasfiye", reason: "ADR-018 Karar 5: ilk üretim döneminde tasfiye kapalıdır; değişiklik kurul kararı gerektirir." },
        { key: "roles", label: "Rol ve yetki matrisi", reason: "Kurumsal görev ayrılığı kararıdır; uygulama kodunda sabittir." },
        { key: "storage", label: "Depolama ve değişmezlik profili", reason: "ADR-016: Object Lock/WORM sağlayıcı tarafında yapılandırılır." },
        { key: "services", label: "Servis adresleri ve jetonları", reason: "Dağıtım sırlarıdır; ortam yapılandırmasından verilir." },
      ],
    }, { headers: { "cache-control": "no-store, private" } });
  } catch (error) {
    return settingsFailure(error, request);
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
    const unit = await createUnit(bindings.DB, {
      actor: principal.email, label: body.label, vocabularyCode: UNIT_VOCABULARY_CODE,
    });
    return Response.json({ unit }, { status: 201 });
  } catch (error) {
    return settingsFailure(error, request);
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
    const unit = await setUnitActive(bindings.DB, {
      actor: principal.email, code: body.code, active: body.active, vocabularyCode: UNIT_VOCABULARY_CODE,
    });
    return Response.json({ unit });
  } catch (error) {
    return settingsFailure(error, request);
  }
}
