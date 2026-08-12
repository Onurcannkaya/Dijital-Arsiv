/**
 * Lokal dosya sistemi depolama sürücüsü sözleşme testleri.
 *
 * S3/R2 adaptörleriyle davranış eşliği: koşullu ilk yazma KEY_ALREADY_EXISTS,
 * içerik SHA reddi PRECONDITION_FAILED, aralıklı okuma, multipart yaşam
 * döngüsü, envanter sayfalaması. Sürücü yalnız lokal geliştirme içindir;
 * üretim/kabul S3 sürücüsünü kullanır.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isObjectStorageError } from "../lib/object-storage.ts";
import {
  storageDisposition, storageInventory, storageReader, storageStaging, storageVaultWriter,
} from "../lib/storage-roles.ts";
import { createLocalFsNamespace } from "../lib/local-fs-object-storage.ts";

const PUT = { contentType: "application/pdf" };
const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const readAll = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());

async function withNamespace(run: (ns: ReturnType<typeof createLocalFsNamespace>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "local-fs-"));
  try {
    await run(createLocalFsNamespace(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("yazma/okuma turu: içerik, tür, üst veri, stat alanları", async () => {
  await withNamespace(async (ns) => {
    const staging = storageStaging(ns);
    const payload = bytesOf("yerel disk nesnesi");
    const written = await staging.put("temporary/s1/payload", payload, {
      contentType: "application/pdf",
      contentSha256Hex: sha(payload),
      customMetadata: { uploadsessionid: "s1" },
    });
    assert.equal(written.size, payload.byteLength);
    assert.equal(written.providerChecksumSha256, sha(payload));

    const read = await storageReader(ns).get("temporary/s1/payload");
    assert.ok(read);
    assert.deepEqual(await readAll(read.body), payload);
    assert.equal(read.customMetadata?.uploadsessionid, "s1");
    assert.equal(read.range, null);
    assert.ok(read.uploadedAt);
    assert.equal((await storageReader(ns).head("temporary/s1/payload"))?.size, payload.byteLength);
    assert.equal(await storageReader(ns).get("yok"), null);
  });
});

test("aralıklı okuma normalize edilmiş aralık ve bodySize döner", async () => {
  await withNamespace(async (ns) => {
    await storageStaging(ns).put("k", bytesOf("0123456789"), PUT);
    const mid = await storageReader(ns).get("k", { range: { offset: 2, length: 5 } });
    assert.deepEqual(await readAll(mid!.body), bytesOf("23456"));
    assert.equal(mid!.size, 10);
    assert.deepEqual(mid!.range, { offset: 2, length: 5 });
  });
});

test("yanlış içerik SHA'sı PRECONDITION_FAILED ile reddedilir", async () => {
  await withNamespace(async (ns) => {
    await assert.rejects(
      () => storageStaging(ns).put("bozuk", bytesOf("icerik"), { contentType: "application/pdf", contentSha256Hex: "0".repeat(64) }),
      (error: unknown) => isObjectStorageError(error, "PRECONDITION_FAILED"),
    );
    assert.equal(await storageReader(ns).head("bozuk"), null);
  });
});

test("koşullu ilk yazma: ikinci yazma KEY_ALREADY_EXISTS, içerik değişmez", async () => {
  await withNamespace(async (ns) => {
    const vault = storageVaultWriter(ns, storageReader(ns));
    await vault.putIfAbsent("originals/d1/o1", bytesOf("asil"), PUT);
    await assert.rejects(
      () => vault.putIfAbsent("originals/d1/o1", bytesOf("saldirgan"), PUT),
      (error: unknown) => isObjectStorageError(error, "KEY_ALREADY_EXISTS"),
    );
    assert.deepEqual(await readAll((await storageReader(ns).get("originals/d1/o1"))!.body), bytesOf("asil"));
  });
});

test("promote: kaynak yoksa OBJECT_NOT_FOUND; varsa koşullu kopyalanır", async () => {
  await withNamespace(async (ns) => {
    const vault = storageVaultWriter(ns, storageReader(ns));
    await assert.rejects(
      () => vault.promote("quarantine/yok", "originals/hedef", PUT),
      (error: unknown) => isObjectStorageError(error, "OBJECT_NOT_FOUND"),
    );
    await storageStaging(ns).put("quarantine/s2/payload", bytesOf("dogrulanmis"), PUT);
    const promoted = await vault.promote("quarantine/s2/payload", "originals/d2/o2", PUT);
    assert.equal(promoted.size, bytesOf("dogrulanmis").byteLength);
    assert.deepEqual(await readAll((await storageReader(ns).get("originals/d2/o2"))!.body), bytesOf("dogrulanmis"));
  });
});

test("multipart yaşam döngüsü: parçalar sıralı birleşir, iptal oturumu kapatır", async () => {
  await withNamespace(async (ns) => {
    const staging = storageStaging(ns);
    const upload = await staging.createMultipartUpload("multi", PUT);
    const p1 = await staging.uploadPart("multi", upload, 1, bytesOf("birinci-"));
    const p2 = await staging.uploadPart("multi", upload, 2, bytesOf("ikinci"));
    const stat = await staging.completeMultipartUpload("multi", upload, [p2, p1]);
    assert.equal(stat.size, bytesOf("birinci-ikinci").byteLength);
    assert.deepEqual(await readAll((await storageReader(ns).get("multi"))!.body), bytesOf("birinci-ikinci"));

    const abandoned = await staging.createMultipartUpload("iptal", PUT);
    await staging.abortMultipartUpload("iptal", abandoned);
    await assert.rejects(
      () => staging.uploadPart("iptal", abandoned, 1, bytesOf("x")),
      (error: unknown) => isObjectStorageError(error, "UPLOAD_NOT_FOUND"),
    );
  });
});

test("envanter öneki süzer, sayfalama imleci ilerler; tasfiye siler", async () => {
  await withNamespace(async (ns) => {
    const staging = storageStaging(ns);
    for (const index of [1, 2, 3]) await staging.put(`originals/a/${index}`, bytesOf(`i-${index}`), PUT);
    await staging.put("temporary/b/1", bytesOf("baska"), PUT);
    const first = await storageInventory(ns).list({ prefix: "originals/", limit: 2 });
    assert.equal(first.objects.length, 2);
    assert.ok(first.cursor);
    const second = await storageInventory(ns).list({ prefix: "originals/", limit: 2, cursor: first.cursor! });
    assert.equal(second.objects.length, 1);
    assert.equal(second.cursor, null);
    assert.deepEqual([...first.objects, ...second.objects].map((o) => o.key),
      ["originals/a/1", "originals/a/2", "originals/a/3"]);

    await storageDisposition(ns).delete("originals/a/1");
    assert.equal(await storageReader(ns).head("originals/a/1"), null);
  });
});
