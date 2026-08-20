/**
 * Yerel dosya sürücüsünde ad alanları ARASI terfi (sözleşme düzeltmesi).
 *
 * `ImmutableVaultWriter.promote` sözleşmesi kaynağı enjekte edilen okuyucudan
 * alır (S3 uygulaması böyle çalışır). Yerel sürücü parametreyi yok sayıp
 * kaynağı HEDEF ad alanında arıyordu; karantina→kasa ve kasa→yedek gibi
 * ad alanları arası terfiler "kaynak bulunamadı" ile düşüyor, aynı ad alanı
 * içinde çalıştığı için de fark edilmiyordu. Kanıtlanan davranış:
 * - kaynak A ad alanında, hedef B ad alanında: terfi baytları ve üst veriyi
 *   taşır, sağlayıcı istatistiği doğru döner;
 * - kaynak yoksa OBJECT_NOT_FOUND;
 * - hedef doluysa KEY_ALREADY_EXISTS (if-absent korunur; üzerine yazılmaz).
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { createLocalFsNamespace } = await import("../lib/local-fs-object-storage.ts");
const { isObjectStorageError } = await import("../lib/object-storage.ts");

const STORE = `.wrangler/tmp/capraz-terfi-${process.pid}`;

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("terfi kaynağı enjekte edilen okuyucudan okunur; ad alanları arası kopya çalışır", async () => {
  const kaynak = createLocalFsNamespace(`${STORE}/karantina`);
  const hedef = createLocalFsNamespace(`${STORE}/kasa`);
  const content = "karantinadan kasaya taşınan asıl";
  const sha = await sha256Hex(content);
  await kaynak.staging.put("quarantine/o1", content, {
    contentType: "application/pdf", contentSha256Hex: sha,
  });

  const writer = hedef.vaultWriter(kaynak.reader);
  const stat = await writer.promote("quarantine/o1", "originals/d1/o1", {
    contentType: "application/pdf", contentSha256Hex: sha,
    customMetadata: { sha256: sha, objectClass: "original" },
  });
  assert.equal(stat.size, new TextEncoder().encode(content).byteLength);

  const promoted = await hedef.reader.get("originals/d1/o1");
  assert.ok(promoted, "terfi edilen nesne hedef ad alanında okunabilmeli");
  const bytes = await new Response(promoted!.body).arrayBuffer();
  assert.equal(new TextDecoder().decode(bytes), content);
  assert.equal(await sha256Hex(content), sha);
  // Kaynak yerinde durur; temizliği ayrı yaşam döngüsü rolü yapar.
  assert.ok(await kaynak.reader.head("quarantine/o1"));
});

test("kaynak yoksa OBJECT_NOT_FOUND, hedef doluysa KEY_ALREADY_EXISTS", async () => {
  const kaynak = createLocalFsNamespace(`${STORE}/karantina-2`);
  const hedef = createLocalFsNamespace(`${STORE}/kasa-2`);
  const writer = hedef.vaultWriter(kaynak.reader);

  await assert.rejects(
    () => writer.promote("quarantine/yok", "originals/d2/o2", { contentType: "application/pdf" }),
    (error: unknown) => isObjectStorageError(error, "OBJECT_NOT_FOUND"),
  );

  const sha = await sha256Hex("içerik");
  await kaynak.staging.put("quarantine/o2", "içerik", { contentType: "application/pdf", contentSha256Hex: sha });
  await writer.promote("quarantine/o2", "originals/d2/o2", { contentType: "application/pdf", contentSha256Hex: sha });
  await assert.rejects(
    () => writer.promote("quarantine/o2", "originals/d2/o2", { contentType: "application/pdf", contentSha256Hex: sha }),
    (error: unknown) => isObjectStorageError(error, "KEY_ALREADY_EXISTS"),
  );
});
