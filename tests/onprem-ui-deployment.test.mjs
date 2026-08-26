import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("kurum içi UI standalone, sırsız ve statik varlık sağlık kontrollüdür", async () => {
  const [dockerfile, compose, dockerignore, nextConfig, healthcheck, builder] = await Promise.all([
    read("server/ui.Dockerfile"),
    read("deploy/kurum-ici/docker-compose.yml"),
    read(".dockerignore"),
    read("next.config.ts"),
    read("server/ui-healthcheck.mjs"),
    read("scripts/build-onprem-ui.mjs"),
  ]);

  assert.match(dockerfile, /npm run build:onprem-ui/);
  assert.match(dockerfile, /npm prune --omit=dev/);
  assert.match(dockerfile, /\/app\/dist\/standalone/);
  assert.match(dockerfile, /\/app\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
  assert.match(dockerfile, /ui-healthcheck\.mjs/);
  assert.match(nextConfig, /ARCHIVE_BUILD_TARGET === "onprem-ui" \? "standalone"/);
  assert.match(healthcheck, /\/archive/);
  assert.ok(healthcheck.includes("\\/assets\\/"));
  assert.match(builder, /dist\/standalone\/dist\/server\/\.dev\.vars/);
  assert.match(builder, /rm\(path, \{ force: true \}\)/);

  const uiBlock = compose.match(/\n  ui:\n([\s\S]*?)\n  # Tek dış kapı/)?.[1] ?? "";
  assert.match(uiBlock, /dockerfile: server\/ui\.Dockerfile/);
  assert.doesNotMatch(uiBlock, /ARCHIVE_S3|SECRET|TOKEN|DB_PATH/);
  for (const ignored of [".git", "node_modules", ".dev.vars", ".env", "data"]) {
    assert.ok(dockerignore.split(/\r?\n/).includes(ignored), `${ignored} Docker bağlamından dışlanmalı`);
  }
});

test("nginx aynı kökte UI sunar, yalnız /api kimlikli API'ye gider", async () => {
  const [base, sso] = await Promise.all([
    read("deploy/kurum-ici/nginx.conf"),
    read("deploy/kurum-ici/sso/nginx.sso.conf.template"),
  ]);

  for (const config of [base, sso]) {
    assert.match(config, /location \/api\/ \{[\s\S]*?proxy_pass http:\/\/api:8788;/);
    assert.match(config, /location \/ \{[\s\S]*?proxy_pass http:\/\/ui:3000;/);
  }
  assert.match(sso, /location \/ \{[\s\S]*?auth_request \/oauth2\/auth;/);
  assert.match(sso, /location ~ \^\/_kabul\(\/\.\*\)\$ \{[\s\S]*?internal;[\s\S]*?proxy_pass http:\/\/api:8788/);
});
