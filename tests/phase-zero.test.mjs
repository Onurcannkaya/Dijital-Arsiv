import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("R2 erişimleri ADR-012 depolama arayüzünün arkasındadır", async () => {
  const [contract, adapter, archiveStorage, documents, fileRoute, processor] = await Promise.all([
    read("lib/object-storage.ts"),
    read("lib/r2-object-storage.ts"),
    read("lib/archive-storage.ts"),
    read("app/api/documents/route.ts"),
    read("app/api/documents/[id]/file/route.ts"),
    read("app/api/jobs/process/route.ts"),
  ]);
  assert.match(contract, /export interface ObjectStorage/);
  // F1.1: sözleşme dosyası sağlayıcıdan bağımsızdır; R2'ye özgü kod adaptör dosyasındadır.
  assert.doesNotMatch(contract, /R2Bucket/);
  assert.match(adapter, /export class R2ObjectStorage implements ObjectStorage/);
  assert.match(archiveStorage, /getArchiveObjectStorage/);
  for (const source of [documents, fileRoute, processor]) {
    assert.doesNotMatch(source, /ARCHIVE_FILES\.(?:get|put|delete|head|list)\(/);
  }
  const apiRoot = new URL("../app/api/", import.meta.url);
  const routeFiles = (await readdir(apiRoot, { recursive: true }))
    .filter((path) => path.endsWith(".ts"));
  for (const routeFile of routeFiles) {
    const source = await readFile(new URL(routeFile.replaceAll("\\", "/"), apiRoot), "utf8");
    assert.doesNotMatch(source, /\bR2Bucket\b|ARCHIVE_FILES\.(?:get|put|delete|head|list)\(/,
      `${routeFile} sağlayıcı adaptörünü atlıyor`);
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
  assert.match(jobs, /processNextPromotionJob/);
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
    "CONTENT_SCAN_SERVICE_URL", "CONTENT_SCAN_SERVICE_TOKEN",
    "OCR_SERVICE_URL", "OCR_SERVICE_TOKEN", "ARCHIVE_MIGRATION_TOKEN", "ARCHIVE_ADMIN_EMAILS",
  ]) {
    assert.ok(config.includes(secret), `${secret} zorunlu sır sözleşmesinde yok`);
  }
  assert.match(verifier, /POST/);
  assert.match(verifier, /\/api\/admin\/migrate/);
  assert.match(verifier, /\/api\/health/);
  assert.match(health, /status: ready \? "ready" : "degraded"/);
  assert.match(health, /state\.modelReady !== true/);
  assert.match(health, /state\.scannerReady !== true/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm run lint/);
  for (const service of ["content-scan", "ocr", "document-render"]) {
    assert.match(
      workflow,
      new RegExp(`cd services/${service} && python -m unittest discover`),
      `${service} regresyonları ana CI kapısında çalışmalıdır`,
    );
  }
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(sitesPlugin, /cp\(drizzleSource/);
  assert.match(sitesPlugin, /dist", "server", "\.dev\.vars/);
  assert.match(sitesPlugin, /rm\(copiedLocalSecrets/);
});

test("dağıtım workflow'u kaliteyi, dağıtımı, doğrulamayı ve rollback'i bağlar", async () => {
  const [deploy, pkg, validator] = await Promise.all([
    read(".github/workflows/deploy.yml"),
    read("package.json"),
    read("scripts/validate-deploy-config.mjs"),
  ]);
  const scripts = JSON.parse(pkg).scripts;
  // Sıra sözleşmesi: kalite kapısı → dağıtım → dağıtım doğrulaması → koşullu rollback.
  assert.match(deploy, /npm run verify/);
  assert.match(deploy, /node scripts\/validate-deploy-config\.mjs/);
  assert.match(deploy, /id: deploy/);
  assert.match(deploy, /npm run deploy:verify/);
  assert.match(deploy, /npm run "?deploy:\$\{DEPLOY_ENV\}"?/);
  // Rollback yalnız dağıtım başarılıyken ve sonraki adım düştüğünde tetiklenir.
  assert.match(deploy, /if: failure\(\) && steps\.deploy\.outcome == 'success'/);
  assert.match(deploy, /npm run deploy:rollback/);
  // Her iki ortam da elle tetiklenir: sentetik Cloudflare pilotu main'e push'ta
  // kendiliğinden koşmaz (ADR-018; üretim dağıtımı deploy-onprem.yml).
  assert.match(deploy, /workflow_dispatch/);
  assert.doesNotMatch(deploy, /^\s*push:/m);
  assert.match(deploy, /environment: \$\{\{ github\.event\.inputs\.environment \|\| 'staging' \}\}/);
  // Üçüncü taraf action'lar değişmez commit SHA'sına sabitli.
  assert.doesNotMatch(deploy, /uses: [^@\n]+@v\d/);
  // npm scriptleri wrangler dağıtım/rollback komutlarını taşır.
  assert.match(scripts["deploy:staging"], /wrangler deploy --env staging/);
  assert.match(scripts["deploy:production"], /wrangler deploy --env production/);
  assert.match(scripts["deploy:rollback"], /wrangler rollback --env/);
  for (const name of [
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "DEPLOY_BASE_URL", "ARCHIVE_MIGRATION_TOKEN",
  ]) {
    assert.ok(validator.includes(name), `${name} dağıtım ön kontrolünde yok`);
  }
});

test("dağıtım ön kontrolü sırları göstermeden eksik ve bozuk girdileri reddeder", async () => {
  const { validateDeployConfig } = await import("../scripts/validate-deploy-config.mjs");
  const invalid = validateDeployConfig({
    DEPLOY_ENV: "staging",
    CLOUDFLARE_API_TOKEN: "gizli-api-jetonu",
    CLOUDFLARE_ACCOUNT_ID: "eksik",
    DEPLOY_BASE_URL: "http://staging.example/path?token=gizli",
    ARCHIVE_MIGRATION_TOKEN: "kisa",
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.failures, [
    "CLOUDFLARE_ACCOUNT_ID_INVALID",
    "DEPLOY_BASE_URL_INVALID",
    "ARCHIVE_MIGRATION_TOKEN_INVALID",
  ]);
  assert.ok(!JSON.stringify(invalid).includes("gizli-api-jetonu"));

  const valid = validateDeployConfig({
    DEPLOY_ENV: "production",
    CLOUDFLARE_API_TOKEN: "gizli-api-jetonu",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    DEPLOY_BASE_URL: "https://arsiv.example",
    ARCHIVE_MIGRATION_TOKEN: "0123456789abcdef",
  });
  assert.deepEqual(valid, { ok: true, environment: "production", failures: [] });
});

test("Faz 0 kanıtı dağıtım, cron OCR ve insan arşivleme zincirini birlikte ister", async () => {
  const [{ buildPhaseZeroEvidence }, { validatePhaseZeroEvidence }] = await Promise.all([
    import("../scripts/collect-phase-zero-evidence.mjs"),
    import("../scripts/verify-phase-zero-evidence.mjs"),
  ]);
  const gitCommit = "a".repeat(40);
  const input = {
    deployment: {
      event: "deployment.verified", environment: "staging", gitCommit,
      health: "ready", schemaVersion: 33,
    },
    health: {
      status: "ready", correlationId: "health-correlation-1",
      checks: { schema: { ok: true, version: 33 } },
    },
    acceptance: {
      sessionId: "session-pilot-1", documentId: "document-pilot-1", terminalStatus: "ACCEPTED",
      transitionChain: { valid: true },
      counts: { documents: 1, originalObjects: 1, ocrJobs: 1, verifiedPromotions: 1 },
      pilotLifecycle: {
        documentId: "document-pilot-1", documentStatus: "archived",
        uploadedBy: "pilot@example.test", ocrJobId: "ocr-job-pilot-1",
        ocrJobStatus: "completed", ocrModel: "paddle-v1", pageCount: 1,
        cronOcrEvent: 2, archiveEvent: 3, archiveActor: "pilot@example.test",
      },
    },
    detail: {
      document: { id: "document-pilot-1", status: "archived", uploadedBy: "pilot@example.test" },
      ocrJob: { id: "ocr-job-pilot-1", status: "completed", model: "paddle-v1" },
      pages: [{ pageNumber: 1 }],
      audit: [],
    },
    correlationId: "phase0-correlation-1",
    collectedAt: "2026-08-25T12:00:00.000Z",
  };
  const evidence = buildPhaseZeroEvidence(input);
  assert.equal(evidence.result, "PASS");
  assert.equal(evidence.pilot.cronAuditEvent, 2);
  assert.equal(evidence.pilot.archiveAuditEvent, 3);
  assert.equal(validatePhaseZeroEvidence(evidence, gitCommit).ok, true);

  assert.throws(() => buildPhaseZeroEvidence({
    ...input,
    acceptance: {
      ...input.acceptance,
      pilotLifecycle: { ...input.acceptance.pilotLifecycle, cronOcrEvent: null },
    },
  }), /PHASE_ZERO_CRON_NOT_PROVEN/);
});

test("Faz 0 pilot workflow'u imzalı dağıtım kanıtını salt-okunur canlı kanıta bağlar", async () => {
  const [workflow, acceptanceWorkflow] = await Promise.all([
    read(".github/workflows/phase-zero-evidence.yml"),
    read(".github/workflows/phase-one-acceptance.yml"),
  ]);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /deployment-evidence-\$\{DEPLOYMENT_RUN_ID\}/);
  assert.match(workflow, /\.github\/workflows\/deploy\.yml\|\.github\/workflows\/deploy-onprem\.yml/);
  assert.match(workflow, /gh attestation verify outputs\/phase-zero\/deployment\/verification\.json/);
  assert.match(workflow, /collect-phase-zero-evidence\.mjs/);
  assert.match(workflow, /verify-phase-zero-evidence\.mjs/);
  assert.match(workflow, /actions\/attest@/);
  assert.doesNotMatch(workflow, /uses: [^@\n]+@v\d/);
  assert.match(acceptanceWorkflow, /phase-zero-evidence-\$\{PHASE_ZERO_RUN_ID\}/);
  assert.match(acceptanceWorkflow, /ACCEPTANCE_PHASE_ZERO_RESULT: PASS/);
  assert.doesNotMatch(acceptanceWorkflow, /ACCEPTANCE_PHASE_ZERO_RESULT: \$\{\{ vars\./);
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
