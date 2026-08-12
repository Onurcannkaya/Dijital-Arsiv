/**
 * Kabul edilen belge biçimleri — sözleşme ve rota davranışı.
 *
 * Liste iki ayrı dilde yaşıyor: uygulama tarafında `lib/ingest-contract.ts`,
 * tarama servisinde `services/content-scan/app/file_validation.py`. Aynı kuralın
 * iki uygulaması sessizce ayrışır — `search_text` normalleştirmesinde bunun
 * bedeli ödendi — bu yüzden eşitlik test edilir, güvenilmez.
 *
 * İçeriğe bakan asıl denetim tarama servisindedir (K-1 kabul testi); buradaki
 * rota denetimi yalnız baştan bilinebileni baştan söyler.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { ACCEPTED_FILE_EXTENSIONS, ACCEPTED_MEDIA_TYPES, isAcceptedMediaType } =
  await import("../lib/ingest-contract.ts");
const STAFF = "yukleyen@sivas.bel.tr";
const UNIT = "Yazı İşleri Müdürlüğü";

test("uygulama ve tarama servisi aynı biçim listesini kullanır", async () => {
  const python = await readFile(
    new URL("../services/content-scan/app/file_validation.py", import.meta.url), "utf8");
  const block = /MIME_EXTENSIONS = \{([\s\S]*?)\n\}/.exec(python)?.[1];
  assert.ok(block, "MIME_EXTENSIONS bloğu okunamadı");

  const fromPython = new Map<string, string[]>();
  for (const line of block.split("\n")) {
    const entry = /"([^"]+)":\s*\{([^}]*)\}/.exec(line);
    if (!entry) continue;
    fromPython.set(entry[1], [...entry[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort());
  }

  const fromTypescript = new Map(Object.entries(ACCEPTED_MEDIA_TYPES)
    .map(([type, extensions]) => [type, [...extensions].sort()]));

  assert.deepEqual([...fromTypescript.keys()].sort(), [...fromPython.keys()].sort(),
    "kabul edilen MIME türleri ayrışmış");
  for (const [type, extensions] of fromTypescript) {
    assert.deepEqual(extensions, fromPython.get(type), `${type} uzantıları ayrışmış`);
  }
});

test("biçim sorgusu büyük/küçük harfe ve boşluğa takılmaz", () => {
  assert.equal(isAcceptedMediaType("application/pdf"), true);
  assert.equal(isAcceptedMediaType("  APPLICATION/PDF  "), true);
  assert.equal(isAcceptedMediaType("image/tiff"), true);
  assert.equal(isAcceptedMediaType("application/x-msdownload"), false);
  assert.equal(isAcceptedMediaType(""), false);
  // Nesne prototipinden gelen adlar biçim sanılmamalıdır.
  assert.equal(isAcceptedMediaType("constructor"), false);
  assert.equal(isAcceptedMediaType("toString"), false);
  assert.ok(ACCEPTED_FILE_EXTENSIONS.includes(".pdf"));
});

test("desteklenmeyen biçim için yükleme oturumu hiç açılmaz", async () => {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/yukleme-bicim",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    const open = async (mediaType: string) => {
      const response = await fetch(`${server.url}/api/uploads`, {
        method: "POST",
        headers: {
          "oai-authenticated-user-email": STAFF,
          "content-type": "application/json",
          "idempotency-key": `bicim-${mediaType}`,
        },
        body: JSON.stringify({ unit: UNIT, byteSize: 601, mediaType, originalName: "prova.pdf" }),
      });
      return { status: response.status, body: await response.json().catch(() => null) as { error?: string } };
    };

    /*
     * Kabul edilirse memur 2 GiB'a kadar dosyayı yükler, baytlar karantina
     * deposunu işgal eder ve ret ancak taramada gelir. Reddin gerekçesi hangi
     * biçimlerin kabul edildiğini de söylemelidir.
     */
    const rejected = await open("application/x-msdownload");
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error ?? "", /Desteklenmeyen belge biçimi/);
    assert.match(rejected.body.error ?? "", /\.pdf/);

    assert.equal((await open("")).status, 400);
    assert.equal((await open("text/html")).status, 400);

    // Kabul edilen her biçim için oturum açılabilmelidir.
    for (const mediaType of Object.keys(ACCEPTED_MEDIA_TYPES)) {
      assert.equal((await open(mediaType)).status, 201, mediaType);
    }
  } finally {
    await server.close();
  }
});
