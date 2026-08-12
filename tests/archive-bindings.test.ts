/**
 * Kurum içi port P1 — çalışma zamanından bağımsız bağlama dikişi.
 *
 * Bu test dosyası bilinçli olarak `archive-storage.ts`'i DEĞİL dikiş modülünü
 * içe aktarır: dikişin `cloudflare:workers` olmadan Node üzerinde yüklenip
 * çalışabildiğinin kanıtı budur. Workers tarafı `workers-runtime.ts` ile aynı
 * kayıt noktasını kullanır.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  createNodeEnvBindingsProvider,
  resolveArchiveBindings,
  setArchiveBindingsProvider,
  type NodeRuntimeAdapters,
} from "../lib/archive-bindings.ts";

const fakeDb = { prepare: () => ({}) } as unknown as D1Database;
const fakeBucket = { get: () => null } as unknown as R2Bucket;
const adapters: NodeRuntimeAdapters = { db: fakeDb, archiveFiles: fakeBucket };

afterEach(() => setArchiveBindingsProvider(null));

test("sağlayıcı kayıtlı değilse depolama katmanı fail-closed açılır", () => {
  assert.throws(() => resolveArchiveBindings(), /sağlayıcısı kayıtlı değil/);
});

test("veritabanı veya dosya kasası eksikse çözüm reddedilir", () => {
  setArchiveBindingsProvider(() => ({ DB: fakeDb }));
  assert.throws(() => resolveArchiveBindings(), /bağlaması kullanılamıyor/);
  setArchiveBindingsProvider(() => ({ ARCHIVE_FILES: fakeBucket }));
  assert.throws(() => resolveArchiveBindings(), /bağlaması kullanılamıyor/);
});

test("kayıtlı sağlayıcının bağlamaları olduğu gibi döner", () => {
  setArchiveBindingsProvider(() => ({ DB: fakeDb, ARCHIVE_FILES: fakeBucket, APP_ENV: "staging" }));
  const bindings = resolveArchiveBindings();
  assert.equal(bindings.DB, fakeDb);
  assert.equal(bindings.ARCHIVE_FILES, fakeBucket);
  assert.equal(bindings.APP_ENV, "staging");
});

test("Node sağlayıcısı adaptörleri ve ortam yapılandırmasını birleştirir", () => {
  const env: Record<string, string | undefined> = {
    APP_ENV: "staging",
    ARCHIVE_MIGRATION_TOKEN: "m".repeat(32),
    ARCHIVE_ACCEPTANCE_TOKEN: "a".repeat(32),
    ARCHIVE_ADMIN_EMAILS: "yonetici@sivas.bel.tr",
    OCR_SERVICE_URL: "https://ocr.internal",
    // İlgisiz anahtarlar bağlamaya taşınmaz.
    PATH: "/usr/bin",
  };
  setArchiveBindingsProvider(createNodeEnvBindingsProvider(
    { ...adapters, quarantineFiles: fakeBucket, temporaryFiles: fakeBucket },
    env,
  ));
  const bindings = resolveArchiveBindings();
  assert.equal(bindings.DB, fakeDb);
  assert.equal(bindings.QUARANTINE_FILES, fakeBucket);
  assert.equal(bindings.APP_ENV, "staging");
  assert.equal(bindings.ARCHIVE_MIGRATION_TOKEN, "m".repeat(32));
  assert.equal(bindings.OCR_SERVICE_URL, "https://ocr.internal");
  assert.ok(!("PATH" in bindings));
});

test("boş dize ortam değeri tanımsız sayılır: fail-closed uçlar yanlışlıkla açılmaz", () => {
  const env: Record<string, string | undefined> = {
    ARCHIVE_MIGRATION_TOKEN: "   ",
    ARCHIVE_ACCEPTANCE_TOKEN: "",
  };
  setArchiveBindingsProvider(createNodeEnvBindingsProvider(adapters, env));
  const bindings = resolveArchiveBindings();
  assert.equal(bindings.ARCHIVE_MIGRATION_TOKEN, undefined);
  assert.equal(bindings.ARCHIVE_ACCEPTANCE_TOKEN, undefined);
});

test("ortam değerleri her çözümde yeniden okunur", () => {
  const env: Record<string, string | undefined> = {};
  setArchiveBindingsProvider(createNodeEnvBindingsProvider(adapters, env));
  assert.equal(resolveArchiveBindings().APP_ENV, undefined);
  env.APP_ENV = "staging";
  assert.equal(resolveArchiveBindings().APP_ENV, "staging");
});
