import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("R2 erişimleri ADR-012 depolama arayüzünün arkasındadır", async () => {
  const [adapter, archiveStorage, documents, fileRoute, processor] = await Promise.all([
    read("lib/object-storage.ts"),
    read("lib/archive-storage.ts"),
    read("app/api/documents/route.ts"),
    read("app/api/documents/[id]/file/route.ts"),
    read("app/api/jobs/process/route.ts"),
  ]);
  assert.match(adapter, /export interface ObjectStorage/);
  assert.match(adapter, /export class R2ObjectStorage implements ObjectStorage/);
  assert.match(archiveStorage, /getArchiveObjectStorage/);
  for (const source of [documents, fileRoute, processor]) {
    assert.doesNotMatch(source, /ARCHIVE_FILES\.(?:get|put|delete|head|list)\(/);
  }
});

test("cron tetikleyicileri Worker zamanlanmış işleyicisine bağlıdır", async () => {
  const [worker, jobs, config] = await Promise.all([
    read("worker/index.ts"),
    read("lib/scheduled-jobs.ts"),
    read("wrangler.jsonc"),
  ]);
  assert.match(worker, /async scheduled\(/);
  assert.match(worker, /ctx\.waitUntil\(runScheduledJob/);
  assert.match(jobs, /processNextOcrJob/);
  assert.match(jobs, /runMaintenanceSlice/);
  assert.match(jobs, /runIntegritySlice/);
  for (const cron of ["*/2 * * * *", "*/5 * * * *", "17 */6 * * *"]) {
    assert.ok(config.includes(cron), `${cron} yapılandırmada yok`);
  }
});

test("OCR kuyruğu exponential backoff ve dead-letter görünürlüğü sağlar", async () => {
  const [processor, schema, overview] = await Promise.all([
    read("app/api/jobs/process/route.ts"),
    read("lib/archive-schema.ts"),
    read("app/api/overview/route.ts"),
  ]);
  assert.match(processor, /30 \* \(2 \*\* Math\.max\(0, job\.attempt - 1\)\)/);
  assert.match(processor, /Math\.min\(3600/);
  assert.match(processor, /next_attempt_at/);
  assert.match(processor, /dead_lettered_at/);
  assert.match(schema, /version: 7, run: migrateProcessingJobOperationsColumns/);
  assert.match(overview, /deadLetter/);
  assert.match(overview, /errorRate24h/);
  assert.match(overview, /readIntegrityProgress/);
});

test("dağıtım sözleşmesi sırları, şema göçünü ve readiness kontrolünü zorunlu kılar", async () => {
  const [config, verifier, health, workflow, sitesPlugin] = await Promise.all([
    read("wrangler.jsonc"),
    read("scripts/verify-deployment.mjs"),
    read("app/api/health/route.ts"),
    read(".github/workflows/ci.yml"),
    read("build/sites-vite-plugin.ts"),
  ]);
  for (const secret of [
    "OCR_SERVICE_URL", "OCR_SERVICE_TOKEN", "ARCHIVE_MIGRATION_TOKEN", "ARCHIVE_ADMIN_EMAILS",
  ]) {
    assert.ok(config.includes(secret), `${secret} zorunlu sır sözleşmesinde yok`);
  }
  assert.match(verifier, /POST/);
  assert.match(verifier, /\/api\/admin\/migrate/);
  assert.match(verifier, /\/api\/health/);
  assert.match(health, /status: ready \? "ready" : "degraded"/);
  assert.match(health, /state\.modelReady !== true/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(sitesPlugin, /cp\(drizzleSource/);
});

test("OCR üretim imajı modeli gömer ve ayrıcalıksız kullanıcıyla çalışır", async () => {
  const [dockerfile, downloader, service] = await Promise.all([
    read("services/ocr/Dockerfile"),
    read("services/ocr/scripts/download_models.py"),
    read("services/ocr/app/main.py"),
  ]);
  assert.match(dockerfile, /RUN python \.\/scripts\/download_models\.py/);
  assert.match(dockerfile, /USER ocr/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(downloader, /engine\(\)/);
  assert.match(service, /modelReady/);
  assert.match(service, /OCR_PRELOAD_MODEL/);
});
