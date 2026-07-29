import { authorizeRequest } from "../../../../lib/authorization";
import {
  getArchiveBindings, readMaintenanceProgress, requireArchiveSchema, runMaintenanceSlice,
} from "../../../../lib/archive-storage";
import { failure } from "../../../../lib/errors";

export const dynamic = "force-dynamic";

/**
 * Uzun süren bakım işlerini sınırlı dilimler hâlinde çalıştırır.
 *
 * Arama dizininin yenilenmesi bütün arşivi dolaşır; bunu göç adımının içinde tek
 * istekte yapmak büyük arşivde zaman aşımına ve her denemede baştan başlamaya yol
 * açar. Göç işi yalnız kuyruğa alır, işleme burada yapılır: her çağrı kilit alır,
 * sınırlı sayıda paket işler ve imleci kalıcılaştırır. `remaining` sıfırlanana
 * kadar tekrar çağrılır (elle, zamanlanmış görevle veya dağıtım adımında).
 *
 * Şema zaten kurulu olduğu için yetki rol sistemiyle verilir; göç uç noktasının
 * ortam sırrına burada gerek yoktur.
 */
export async function GET(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "users.manage", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;
    return Response.json({ progress: await readMaintenanceProgress(bindings.DB) });
  } catch (error) {
    return failure(error, "maintenance.read", "Bakım durumu alınamadı.", request);
  }
}

export async function POST(request: Request) {
  try {
    const bindings = getArchiveBindings();
    const schemaError = await requireArchiveSchema(request, bindings.DB);
    if (schemaError) return schemaError;
    const principal = await authorizeRequest(request, bindings.DB, "users.manage", bindings.ARCHIVE_ADMIN_EMAILS);
    if (principal instanceof Response) return principal;

    const parameters = new URL(request.url).searchParams;
    const batchSize = Number(parameters.get("batchSize") ?? 200);
    const maxBatches = Number(parameters.get("maxBatches") ?? 5);
    const result = await runMaintenanceSlice(bindings.DB, { batchSize, maxBatches });
    return Response.json({
      claimed: result.claimed,
      progress: result.progress,
      // Kilit başka bir çalıştırmada olduğunda `claimed` yanlış döner; bu bir
      // hata değildir, eşzamanlı çalıştırma engellenmiştir.
      message: result.claimed
        ? (result.progress?.done ? "Bakım işi tamamlandı." : "Bir dilim işlendi; kalan için tekrar çağırın.")
        : "İş başka bir çalıştırma tarafından işleniyor veya tamamlanmış.",
    });
  } catch (error) {
    return failure(error, "maintenance.run", "Bakım işi çalıştırılamadı.", request);
  }
}
