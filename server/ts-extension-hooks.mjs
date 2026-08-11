/**
 * Kurum içi port P4 — Node ESM çözümleme kancası.
 *
 * app/api rota modülleri Next geleneğiyle uzantısız göreli import kullanır
 * (`../../lib/authorization`); Node'un ham ESM çözümleyicisi açık uzantı
 * ister. Bu kanca yalnız göreli ve çözülemeyen belirteçlerde sırayla `.ts`,
 * `.tsx` ve `/index.ts` dener; paket çözümlemesine dokunmaz. Sunucu girişi ve
 * Node testleri `module.register` ile yükler; Workers/vite build'i bu dosyayı
 * hiç görmez.
 */

const RELATIVE = /^\.{1,2}\//;
const SUFFIXES = [".ts", ".tsx", "/index.ts"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || !RELATIVE.test(specifier)) throw error;
    for (const suffix of SUFFIXES) {
      try {
        return await nextResolve(`${specifier}${suffix}`, context);
      } catch {
        // sıradaki uzantı denenir
      }
    }
    throw error;
  }
}
