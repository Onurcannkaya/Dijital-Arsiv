import { authorizeRequest } from "../../../../lib/authorization";
import { getArchiveBindings, requireArchiveSchema } from "../../../../lib/archive-storage";
import { failure } from "../../../../lib/errors";
import { CONTENT_SCAN_CRON, runScheduledJob } from "../../../../lib/scheduled-jobs";

export const dynamic = "force-dynamic";

/**
 * İçerik tarama kuyruğunu elle bir tur ilerletir.
 *
 * Tarama normalde cron ile döner (dakikada bir). Yerel geliştirmede cron
 * tetikleyicisi ateşlenmez ve karantinadaki belge sonsuza dek bekler; işletimde
 * de birikmiş kuyruğu beklemeden ilerletmek gerekebilir. Bakım ucundaki
 * desenin aynısı: rol yetkisi ister, kilitler eşzamanlı koşuyu zaten engeller.
 */
export async function POST(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "users.manage", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    if (!bindings.CONTENT_SCAN_SERVICE_URL || !bindings.CONTENT_SCAN_SERVICE_TOKEN) {
      return Response.json({
        error: "İçerik tarama servisi yapılandırılmamış (CONTENT_SCAN_SERVICE_URL / CONTENT_SCAN_SERVICE_TOKEN).",
      }, { status: 503 });
    }
    await runScheduledJob(bindings, CONTENT_SCAN_CRON);
    return Response.json({ triggered: true });
  } catch (error) {
    return failure(error, "scan.trigger", "Tarama turu çalıştırılamadı.", request);
  }
}
