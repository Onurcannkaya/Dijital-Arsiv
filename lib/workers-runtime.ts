/**
 * Workers çalışma zamanı önyüklemesi (kurum içi port P1/P4).
 *
 * Depo genelinde `cloudflare:workers` sanal modülüne başvuran TEK dosya budur.
 * İçe aktarma dinamiktir ve üst-düzey await ile çözülür: Workers/vite
 * ortamında pilotun bağlamaları (D1, R2, worker sırları) dikişe kaydedilir;
 * Node çalışma zamanında modül bulunamaz, kayıt sessizce atlanır ve önyükleme
 * `lib/node-runtime.ts` içindeki `bootstrapNodeRuntime` çağrısına kalır.
 * Böylece rota modülleri her iki çalışma zamanında da aynı import grafiğiyle
 * yüklenebilir; bundler takası gerekmez.
 */

import { setArchiveBindingsProvider, type ArchiveBindings } from "./archive-bindings.ts";

try {
  const { env } = await import("cloudflare:workers");
  setArchiveBindingsProvider(() => env as unknown as Partial<ArchiveBindings>);
} catch {
  // Node: cloudflare:workers yok; sağlayıcıyı Node önyüklemesi kaydeder.
}
