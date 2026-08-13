import { authorizeRequest } from "../../../lib/authorization";
import { UNIT_VOCABULARY_CODE } from "../../../lib/archive-seed";
import {
  ARCHIVE_SCHEMA_VERSION, getArchiveBindings, jsonError, readMaintenanceProgress,
  readSchemaVersion, requireArchiveSchema,
} from "../../../lib/archive-storage";
import { failure } from "../../../lib/errors";
import { UnitDirectoryError, createUnit, listUnits, setUnitActive } from "../../../lib/unit-directory";
import { rejectionReasonVocabulary } from "../../../lib/rejection-reasons";
import { createTerm, listTerms, setTermActive } from "../../../lib/vocabulary-directory";

/**
 * Ayarlardan yönetilebilen sözlükler.
 *
 * Müdürlük listesi kendi uçlarını korur (erişim kapsamına dayandığı için ayrı
 * bir alan olarak sunulur); ret gerekçeleri buradan gelir. Yeni bir kurum
 * listesi eklendiğinde tek yapılacak bu haritaya bir satır yazmaktır.
 */
const MANAGED_VOCABULARIES = [
  {
    key: "field-rejection-reason",
    name: "Alan değeri ret gerekçeleri",
    description: "Personel bir OCR alan değerini reddederken seçer; denetim izine kodla ve etiketle yazılır.",
    vocabulary: rejectionReasonVocabulary("field"),
  },
  {
    key: "relation-rejection-reason",
    name: "Varlık ilişkisi ret gerekçeleri",
    description: "Ada/parsel veya adres ilişkisi reddedilirken seçilir; denetim izine kodla ve etiketle yazılır.",
    vocabulary: rejectionReasonVocabulary("relation"),
  },
] as const;

function managedVocabulary(key: unknown) {
  return MANAGED_VOCABULARIES.find((entry) => entry.key === key);
}

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
  // `UnitDirectoryError` ortak sözlük hatasının kendisidir; ret gerekçeleri de
  // aynı sınıfı fırlatır.
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

    const [units, vocabularies, schemaVersion, maintenance] = await Promise.all([
      listUnits(bindings.DB, UNIT_VOCABULARY_CODE),
      Promise.all(MANAGED_VOCABULARIES.map(async (entry) => ({
        key: entry.key, name: entry.name, description: entry.description,
        terms: await listTerms(bindings.DB, entry.vocabulary),
      }))),
      readSchemaVersion(bindings.DB),
      readMaintenanceProgress(bindings.DB),
    ]);
    return Response.json({
      units,
      vocabularies,
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
    // `vocabulary` verilmezse müdürlük listesi hedeflenir.
    if (body.vocabulary !== undefined) {
      const managed = managedVocabulary(body.vocabulary);
      if (!managed) return jsonError("Yönetilebilir sözlük bulunamadı.", 404);
      const term = await createTerm(bindings.DB, managed.vocabulary, { actor: principal.email, label: body.label });
      return Response.json({ term, vocabulary: managed.key }, { status: 201 });
    }
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
    if (body.vocabulary !== undefined) {
      const managed = managedVocabulary(body.vocabulary);
      if (!managed) return jsonError("Yönetilebilir sözlük bulunamadı.", 404);
      const term = await setTermActive(bindings.DB, managed.vocabulary,
        { actor: principal.email, code: body.code, active: body.active });
      return Response.json({ term, vocabulary: managed.key });
    }
    const unit = await setUnitActive(bindings.DB, {
      actor: principal.email, code: body.code, active: body.active, vocabularyCode: UNIT_VOCABULARY_CODE,
    });
    return Response.json({ unit });
  } catch (error) {
    return settingsFailure(error, request);
  }
}
