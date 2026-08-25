import vinext from "vinext";
import { defineConfig, type PluginOption } from "vite";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.ts";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;
const isOnPremUiBuild = process.env.ARCHIVE_BUILD_TARGET === "onprem-ui";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// Yerel Miniflare, kurulu workerd binary'sinin desteklediği tarihten yenisini
// reddeder ve dev sunucusu hiç açılmaz. Üretim/dağıtım tarihi wrangler.jsonc'ta
// kalır; bu değer YALNIZ yerel emülasyon içindir. workerd güncellendiğinde
// (npm i ile) bu satır kaldırılıp wrangler.jsonc tarihine dönülmelidir.
const LOCAL_COMPATIBILITY_DATE = "2026-05-22";

/**
 * `.dev.vars` yerel bağlara elle taşınır: buradaki inline yapılandırma
 * wrangler.jsonc'un yerine geçtiğinden eklenti dosyayı kendisi okumuyor ve
 * yeni anahtarlar (servis jetonları, ARCHIVE_INTERNAL_OBJECT_FETCH) Worker'a
 * hiç ulaşmıyordu. Dosya .gitignore'dadır; sırlar depoya girmez.
 */
function readDevVars(): Record<string, string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const raw = require("node:fs").readFileSync(".dev.vars", "utf8") as string;
    return Object.fromEntries(raw.split(String.fromCharCode(10))
      .filter((line: string) => line.includes("=") && !line.trimStart().startsWith("#"))
      .map((line: string) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }));
  } catch {
    return {};
  }
}

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_date: LOCAL_COMPATIBILITY_DATE,
  vars: readDevVars(),
  // `nodejs_compat` yalnız wrangler.jsonc'ta tanımlıdır. Burada tekrar
  // verilmesi Miniflare'de "flag specified multiple times" hatasına yol açar
  // ve dev sunucusu hiç açılmaz.
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  /*
   * Kabul hattı ADR-014 gereği dört ayrı yetki alanı kullanır: geçici yükleme,
   * karantina, asıl kasa ve türev. Yerel emülasyonda yalnız asıl kasa
   * tanımlıyken `/api/uploads` "TEMPORARY_FILES ve QUARANTINE_FILES ...
   * yapılandırılmalıdır" hatasıyla düşüyordu; belge yükleme akışı yerelde hiç
   * denenemiyordu. Her bağ ayrı bir yerel kovaya işaret eder ki alanların
   * ayrımı geliştirmede de korunsun.
   */
  r2_buckets: r2
    ? [r2, "DERIVATIVE_FILES", "TEMPORARY_FILES", "QUARANTINE_FILES"].map((binding) => ({
        binding,
        bucket_name: `site-creator-r2-${binding.toLowerCase().replace(/_/g, "-")}`,
      }))
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const platformPlugins: PluginOption[] = [];
  // Vinext'in RSC üretim grafiği Cloudflare eklentisini build sırasında da
  // ister. Kurum içi standalone çıktıda yalnız Sites paketleme adımı atlanır.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  if (!isOnPremUiBuild) platformPlugins.push(sites());
  platformPlugins.push(cloudflare({
    viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    config: localBindingConfig,
  }));

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [vinext(), ...platformPlugins],
  };
});
