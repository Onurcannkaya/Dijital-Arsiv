import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";

const result = spawnSync(process.execPath, ["node_modules/vinext/dist/cli.js", "build"], {
  cwd: process.cwd(),
  env: { ...process.env, ARCHIVE_BUILD_TARGET: "onprem-ui" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Cloudflare eklentisinin yerel bağlama kopyası standalone imaja giremez.
// Docker bağlamı zaten sır dosyalarını dışlar; bu ikinci bekçi yerel build
// çıktısının da yanlışlıkla dağıtılmasını engeller.
await Promise.all([
  "dist/server/.dev.vars",
  "dist/standalone/dist/server/.dev.vars",
].map((path) => rm(path, { force: true })));
