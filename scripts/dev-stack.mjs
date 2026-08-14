#!/usr/bin/env node
/**
 * YALNIZ YEREL GELİŞTİRME — yardımcı servis yığınını tek komutla kaldırır.
 *
 * `npm run dev` uygulamayı açar ama zincirin kalanı üç ayrı el işi istiyordu:
 * OCR servisini başlat, tarama taklidini başlat, tarama/terfi turunu elle
 * tetikle (cron yerelde ateşlenmez). `test_belge.jpeg` yükleyip bekleyen
 * herkes tam bu noktada takılıyordu. Bu betik üçünü birden yapar:
 *
 *   npm run dev:hizmetler
 *
 * - OCR servisi (uvicorn, ısınma dahil: OCR_PRELOAD_MODEL=true)
 * - içerik tarama taklidi (scripts/dev-content-scan.mjs)
 * - tarama vurucusu: uygulama ayaktayken 20 sn'de bir /api/admin/scan
 *   (tur idempotenttir; kuyruk boşsa sessizce geçer)
 *
 * Sırlar `.dev.vars` dosyasından okunur; dosya yoksa açıkça söylenir.
 * Çıkışta (Ctrl+C) iki alt süreç de kapatılır.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const APP = process.env.DEV_APP_URL ?? "http://localhost:3000";
const WINDOWS = process.platform === "win32";

/**
 * Gerçek Python yorumlayıcısını bulur.
 *
 * Windows'ta `python` çoğu kurulumda Microsoft Store ARA KATMANINA
 * (`WindowsApps\python.exe`) çözülür: bu stub asıl yorumlayıcıyı ayrı bir
 * süreç olarak doğurur. Ara katman öldüğünde torun süreç yaşamaya ve 8090'ı
 * TUTMAYA devam eder; sonraki açılış 60 saniyelik ısınmayı ödedikten sonra
 * "yalnızca bir kullanıma izin veriliyor" hatasıyla düşer. Bu oturumda üç kez
 * yaşandı. Ara katmanı atlayıp gerçek yorumlayıcıyı doğrudan çalıştırmak hem
 * bir süreç katmanını hem de o yetim-port sınıfını ortadan kaldırır.
 */
function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  if (!WINDOWS) return "python3";
  // `py -0p` kurulu yorumlayıcıların gerçek yollarını listeler.
  const launcher = spawnSync("py", ["-0p"], { encoding: "utf8" });
  const fromLauncher = (launcher.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().match(/([A-Za-z]:\\[^\r\n]*python\.exe)$/i)?.[1])
    .find((path) => path && !path.includes("WindowsApps"));
  if (fromLauncher) return fromLauncher;
  const candidates = [
    `${homedir()}\\AppData\\Local\\Programs\\Python\\Python312\\python.exe`,
    `${homedir()}\\AppData\\Local\\Programs\\Python\\Python311\\python.exe`,
    "C:\\Python312\\python.exe",
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  console.error("[yigin] Gerçek Python yorumlayıcısı bulunamadı; PYTHON değişkeniyle yolunu verin.");
  process.exit(1);
}

/** Port başkası tarafından tutuluyorsa ısınmayı ödemeden söyler. */
function portBusy(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", (error) => done(error.code === "EADDRINUSE"));
    probe.once("listening", () => probe.close(() => done(false)));
    probe.listen(port, "127.0.0.1");
  });
}

function devVars() {
  try {
    const entries = readFileSync(resolve(ROOT, ".dev.vars"), "utf8")
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
    return Object.fromEntries(entries);
  } catch {
    console.error("[yigin] .dev.vars bulunamadı; LOKAL_GELISTIRME.md'deki anahtarlar olmadan zincir koşamaz.");
    process.exit(1);
  }
}

const vars = devVars();
for (const key of ["OCR_SERVICE_TOKEN", "CONTENT_SCAN_SERVICE_TOKEN"]) {
  if (!vars[key]) {
    console.error(`[yigin] .dev.vars içinde ${key} yok; LOKAL_GELISTIRME.md "Tam hat" bölümüne bakın.`);
    process.exit(1);
  }
}

const PYTHON = resolvePython();
for (const [port, isim] of [[8090, "OCR"], [8091, "tarama taklidi"]]) {
  if (await portBusy(port)) {
    console.error(`[yigin] ${port} portu zaten kullanımda (${isim} için gerekli).`);
    console.error(`[yigin] Eski bir süreç kalmış olabilir; Windows'ta: npx kill-port ${port}  ya da  Get-NetTCPConnection -LocalPort ${port} -State Listen`);
    process.exit(1);
  }
}

const children = [];
function run(name, command, args, options) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, ...options });
  children.push(child);
  const tag = (line) => `[${name}] ${line}`;
  child.stdout.on("data", (data) => String(data).split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag(l))));
  child.stderr.on("data", (data) => String(data).split(/\r?\n/).filter(Boolean).forEach((l) => console.error(tag(l))));
  child.on("exit", (code) => console.error(`[yigin] ${name} kapandı (kod ${code}); Ctrl+C ile çıkıp yeniden başlatın.`));
  return child;
}

run("ocr", PYTHON, ["-u", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8090", "--log-level", "warning"], {
  cwd: resolve(ROOT, "services/ocr"),
  env: {
    ...process.env,
    OCR_SERVICE_TOKEN: vars.OCR_SERVICE_TOKEN,
    OCR_FETCH_URL: `${APP}/api/internal/objects`,
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
    // Isınma zorunlu: ilk gerçek belge oneDNN derleme bedelini ödememeli
    // (aynı görüntü soğukta 155 sn, ısınmışta 38 sn ölçüldü).
    OCR_PRELOAD_MODEL: "true",
  },
});

run("tarama", process.execPath, [resolve(ROOT, "scripts/dev-content-scan.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    CONTENT_SCAN_SERVICE_TOKEN: vars.CONTENT_SCAN_SERVICE_TOKEN,
    INTERNAL_FETCH_URL: `${APP}/api/internal/objects`,
  },
});

/*
 * Tarama vurucusu: cron'un yerel karşılığı. Uygulama kapalıysa sessizce
 * bekler; tur zaten kilitliyken sunucu ikinci koşuyu kendisi reddeder.
 */
async function tick() {
  try {
    const response = await fetch(`${APP}/api/admin/scan`, { method: "POST" });
    if (response.ok) console.log("[vurucu] tarama/terfi turu ilerletildi");
    else if (response.status !== 503) console.error(`[vurucu] tur ${response.status} döndü`);
  } catch {
    /* uygulama henüz ayakta değil; sonraki vuruşta denenir */
  }
}
setInterval(() => { void tick(); }, 20_000);
console.log(`[yigin] OCR (8090) + tarama taklidi (8091) başlatıldı; vurucu ${APP} üzerinde 20 sn'de bir tur atacak.`);
console.log("[yigin] OCR ısınması ilk açılışta birkaç dakika sürer; /api/health 'ready' diyene kadar bekleyin.");

/**
 * Çıkışta süreç AĞACI kapatılır.
 *
 * `child.kill()` yalnız doğrudan çocuğu öldürür; Windows'ta torunlar (ör. bir
 * ara katmanın doğurduğu asıl yorumlayıcı) hayatta kalır ve portu tutmaya
 * devam eder. `taskkill /T` ağacın tamamını kapatır; POSIX'te aynı işi süreç
 * grubuna gönderilen sinyal görür.
 */
function shutdown() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (WINDOWS && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
