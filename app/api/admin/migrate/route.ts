import { applyArchiveMigrations, getArchiveBindings, jsonError, readSchemaVersion, ARCHIVE_SCHEMA_VERSION } from "../../../../lib/archive-storage";
import { failure } from "../../../../lib/errors";

export const dynamic = "force-dynamic";

/**
 * Şema göçlerini uygular.
 *
 * Neden ayrı bir uç nokta: şema değişikliği bir okuma isteğinin yan etkisi
 * olmamalıdır. İstek yolunda yalnız sürüm doğrulanır (`requireArchiveSchema`);
 * DDL yalnız burada veya yerel geliştirmede çalışır.
 *
 * Yetki, veritabanına bağlı rol sistemiyle verilemez: taze bir veritabanında
 * `archive_users` tablosu henüz yoktur ve yönetici doğrulanamaz. Bu yüzden
 * ortam sırrı (`ARCHIVE_MIGRATION_TOKEN`) kullanılır. Sır tanımlı değilse uç
 * nokta kapalıdır — eksik yapılandırma açık kapı üretmez.
 */
function authorizeMigration(request: Request, token?: string) {
  if (!token || token.trim().length < 16) {
    return jsonError("ARCHIVE_MIGRATION_TOKEN tanımlı değil veya çok kısa; göç uç noktası kapalı.", 503);
  }
  const header = request.headers.get("authorization");
  if (header !== `Bearer ${token}`) {
    return jsonError("Göç için geçerli bir yetki anahtarı gereklidir.", 401);
  }
  return null;
}

export async function GET(request: Request) {
  const bindings = getArchiveBindings();
  const refused = authorizeMigration(request, bindings.ARCHIVE_MIGRATION_TOKEN);
  if (refused) return refused;
  const current = await readSchemaVersion(bindings.DB);
  return Response.json({
    currentVersion: current,
    expectedVersion: ARCHIVE_SCHEMA_VERSION,
    pending: current !== ARCHIVE_SCHEMA_VERSION,
  });
}

export async function POST(request: Request) {
  const bindings = getArchiveBindings();
  const refused = authorizeMigration(request, bindings.ARCHIVE_MIGRATION_TOKEN);
  if (refused) return refused;
  try {
    const result = await applyArchiveMigrations(bindings.DB);
    return Response.json({
      applied: result.applied,
      fromVersion: result.from,
      toVersion: result.to,
      message: result.applied
        ? `Şema ${result.from} sürümünden ${result.to} sürümüne taşındı.`
        : `Şema zaten ${result.to} sürümünde.`,
    });
  } catch (error) {
    // Göç yarıda kalırsa sürüm damgası yazılmaz; yeniden çalıştırma güvenlidir.
    return failure(error, "schema.migrate", "Göç uygulanamadı.", request);
  }
}
