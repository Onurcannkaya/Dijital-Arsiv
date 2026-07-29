import { authorizeRequest } from "../../../lib/authorization";
import { requireArchiveSchema, getArchiveBindings } from "../../../lib/archive-storage";
import { UNIT_VOCABULARY_CODE } from "../../../lib/archive-seed";
import { listActiveProfiles, loadVocabularyTerms } from "../../../lib/document-profile";
import { failure } from "../../../lib/errors";

export const dynamic = "force-dynamic";

/**
 * Yürürlükteki belge türü profilleri ve kontrollü listeler.
 *
 * Yükleme ve doğrulama ekranları seçeneklerini buradan alır; arayüzde sabit
 * belge türü veya müdürlük listesi tutulmaz (ADR-008, PROJE_PLANI.md md. 8).
 * Salt okunur: profil düzenleme arayüzü ayrı bir iş paketidir.
 */
export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "document.read", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const [profiles, units] = await Promise.all([
      listActiveProfiles(bindings.DB),
      loadVocabularyTerms(bindings.DB, UNIT_VOCABULARY_CODE),
    ]);

    return Response.json({
      profiles: profiles.map((profile) => ({
        code: profile.code,
        name: profile.name,
        version: profile.profileVersion,
        status: profile.profileStatus,
        ownerDepartment: profile.ownerDepartment,
        fields: profile.fields.map((field) => ({
          fieldCode: field.fieldCode,
          label: field.label,
          dataType: field.dataType,
          cardinality: field.cardinality,
          requirement: field.requirement,
          critical: field.isCritical,
          extractionPolicy: field.extractionPolicy,
          formatHint: field.formatHint,
          vocabularyCode: field.vocabularyCode,
          enforceVocabulary: field.enforceVocabulary,
          entityType: field.entityType,
        })),
      })),
      units: (units ?? []).map((term) => ({ code: term.code, label: term.label })),
    });
  } catch (error) {
    return failure(error, "profiles.read", "Profiller alınamadı.", request);
  }
}
