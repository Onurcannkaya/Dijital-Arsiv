/**
 * Kurum içi port P4 — Node sunucu girişi.
 *
 *   node server/main.ts
 *
 * Önce uzantı çözümleme kancası kaydedilir (rota modülleri Next geleneğiyle
 * uzantısız import kullanır), sonra uygulama dinamik yüklenir. Ortam
 * değişkenleri lib/node-runtime.ts başlığında; sunucu vars. 127.0.0.1:8788
 * dinler ve YALNIZ kimlik başlıklarını enjekte eden ters vekilin arkasında
 * çalıştırılmalıdır (P5).
 */

import { register } from "node:module";

register("./ts-extension-hooks.mjs", import.meta.url);

const { logEvent } = await import("../lib/observability.ts");
const { startNodeServer } = await import("./app.ts");

const server = await startNodeServer();
logEvent("info", "node.server-started", { url: server.url });

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    logEvent("info", "node.server-stopping", { signal });
    void server.close().then(() => process.exit(0));
  });
}
