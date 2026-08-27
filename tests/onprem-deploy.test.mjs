import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateOnpremDeployConfig } from "../scripts/validate-onprem-deploy-config.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const valid = {
  DEPLOY_ENV: "staging",
  ONPREM_IMAGE_PREFIX: "ghcr.io/onurcannkaya/dijital-arsiv",
  ONPREM_IMAGE_TAG: "a".repeat(40),
  ONPREM_ENV_FILE: "/opt/sivas-arsiv/secrets/staging.env",
  ONPREM_RELEASE_STATE_FILE: "/var/lib/sivas-arsiv/staging.release",
  DEPLOY_BASE_URL: "https://arsiv-staging.sivas.bel.tr",
  ARCHIVE_MIGRATION_TOKEN: "m".repeat(32),
};

test("kurum içi dağıtım ön kontrolü sırları göstermeden kapalı hata verir", () => {
  assert.deepEqual(validateOnpremDeployConfig(valid).failures, []);
  const broken = validateOnpremDeployConfig({
    ...valid,
    DEPLOY_ENV: "prod",
    ONPREM_IMAGE_PREFIX: "docker.io/UPPER/repo",
    ONPREM_IMAGE_TAG: "latest",
    ONPREM_ENV_FILE: "relative.env",
    DEPLOY_BASE_URL: "http://localhost:8080",
    ARCHIVE_MIGRATION_TOKEN: "short",
  });
  assert.equal(broken.ok, false);
  assert.deepEqual(new Set(broken.failures), new Set([
    "DEPLOY_ENV_INVALID", "IMAGE_PREFIX_INVALID", "IMAGE_TAG_INVALID",
    "DEPLOY_BASE_URL_INVALID", "ARCHIVE_MIGRATION_TOKEN_INVALID",
    "ONPREM_ENV_FILE_INVALID",
  ]));
});

test("kurum içi workflow SHA imajı, korumalı hedef, doğrulama ve rollback bağlar", async () => {
  const [workflow, overlay, verifier, compose] = await Promise.all([
    read(".github/workflows/deploy-onprem.yml"),
    read("deploy/kurum-ici/docker-compose.release.yml"),
    read("scripts/verify-deployment.mjs"),
    read("deploy/kurum-ici/docker-compose.yml"),
  ]);

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: \[self-hosted, linux, onprem-archive\]/);
  assert.match(workflow, /environment: onprem-\$\{\{ inputs\.environment \}\}/);
  assert.match(workflow, /image_tag=\$GITHUB_SHA/);
  assert.doesNotMatch(workflow, /:latest\b/);
  for (const image of ["archive-api", "archive-ui", "content-scan", "ocr", "document-render"]) {
    assert.ok(workflow.includes(`build_image ${image}`), `${image} workflow build listesinde yok`);
    assert.ok(overlay.includes(`/${image}:\${ONPREM_IMAGE_TAG:?}`), `${image} release overlay'de yok`);
  }
  assert.match(workflow, /node scripts\/verify-deployment\.mjs > outputs\/deployment\/verification\.json/);
  assert.match(workflow, /Başarısızlıkta önceki imajlara dön/);
  assert.match(workflow, /ONPREM_RELEASE_STATE_FILE/);
  assert.match(workflow, /deployment-evidence-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /docker image inspect "\$renderer_image"/);
  assert.match(workflow, /export DOCUMENT_RENDER_IMAGE_DIGEST="\$\{renderer_ref##\*@\}"/);
  assert.match(workflow, /renderer-image-digest\.txt/);
  assert.match(verifier, /DEPLOY_EXPECTED_RELEASE_REVISION/);
  assert.match(verifier, /health\.releaseRevision !== expectedReleaseRevision/);
  assert.match(compose, /ARCHIVE_RELEASE_REVISION: \$\{ONPREM_IMAGE_TAG:-development\}/);
});
