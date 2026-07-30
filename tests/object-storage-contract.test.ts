/**
 * F1.1 — Sağlayıcıdan bağımsız depolama sözleşme paketi.
 *
 * Paket, adaptör takımını fixture olarak alır: burada S3 uyumlu bellek-içi
 * adaptörle koşar; staging kabul koşusunda (F1.11) aynı beklentiler gerçek R2
 * kaynaklarıyla T-01/T-02 kanıtına bağlanır. Sözleşme testinin geçmesi tek
 * başına sağlayıcı kanıtı sayılmaz (FAZ_1_KANIT_REHBERI.md).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ObjectStorageError, isObjectStorageError } from "../lib/object-storage.ts";
import type { PutObjectOptions } from "../lib/object-storage.ts";
import {
  createMemoryStorageFixture,
  createNodeStreamingHasher,
  type MemoryStorageFixture,
} from "./memory-object-storage.ts";

const PUT_OPTIONS: PutObjectOptions = { contentType: "application/pdf" };

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function fixture(): MemoryStorageFixture {
  return createMemoryStorageFixture();
}

// ---------------------------------------------------------------------------
// StreamingHasher sözleşmesi.
// ---------------------------------------------------------------------------

test("StreamingHasher bilinen vektörleri doğru hesaplar", async () => {
  const hasher = createNodeStreamingHasher();
  const empty = await hasher.sha256(streamOf());
  assert.equal(empty.sha256Hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(empty.byteSize, 0);

  const abc = await hasher.sha256(streamOf(bytesOf("abc")));
  assert.equal(abc.sha256Hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(abc.byteSize, 3);
});

test("StreamingHasher parça sınırından bağımsızdır", async () => {
  const hasher = createNodeStreamingHasher();
  const whole = await hasher.sha256(streamOf(bytesOf("sivas dijital arşiv")));
  const chunked = await hasher.sha256(streamOf(bytesOf("sivas "), bytesOf("dijital"), bytesOf(" arşiv")));
  assert.equal(chunked.sha256Hex, whole.sha256Hex);
  assert.equal(chunked.byteSize, whole.byteSize);
});

// ---------------------------------------------------------------------------
// Okuma ve tek parça yazma.
// ---------------------------------------------------------------------------

test("tek parça yazma stat döndürür ve akışla geri okunur", async () => {
  const { quarantine } = fixture();
  const stat = await quarantine.put("temporary/a", "merhaba", PUT_OPTIONS);
  assert.equal(stat.size, bytesOf("merhaba").byteLength);
  assert.equal(stat.contentType, PUT_OPTIONS.contentType);
  assert.ok(stat.etag, "sağlayıcı ETag alanı dolu olmalı");
  assert.ok(stat.providerVersionId, "sağlayıcı sürüm alanı dolu olmalı");

  const body = await quarantine.get("temporary/a");
  assert.ok(body);
  assert.equal(await readText(body.body), "merhaba");
  assert.equal((await quarantine.head("temporary/a"))?.size, stat.size);
  assert.equal(await quarantine.get("temporary/yok"), null);
});

test("aralıklı okuma istenen dilimi döndürür", async () => {
  const { quarantine } = fixture();
  await quarantine.put("temporary/range", "0123456789", PUT_OPTIONS);
  const middle = await quarantine.get("temporary/range", { range: { offset: 2, length: 3 } });
  assert.equal(await readText(middle!.body), "234");
  assert.equal(middle!.size, 10, "nesne boyutu aralıklı okumada değişmemeli");
  assert.equal(middle!.bodySize, 3);
  assert.deepEqual(middle!.range, { offset: 2, length: 3 });
  const tail = await quarantine.get("temporary/range", { range: { offset: 7 } });
  assert.equal(await readText(tail!.body), "789");
  assert.equal(tail!.bodySize, 3);
  await assert.rejects(
    quarantine.get("temporary/range", { range: { offset: -1 } }),
    (error: unknown) => isObjectStorageError(error, "INVALID_ARGUMENT"),
  );
});

test("bildirilen SHA-256 içerikle uyuşmazsa yazma reddedilir", async () => {
  const { quarantine, hasher } = fixture();
  await assert.rejects(
    quarantine.put("temporary/sha", "içerik", { ...PUT_OPTIONS, contentSha256Hex: "0".repeat(64) }),
    (error: unknown) => isObjectStorageError(error, "PRECONDITION_FAILED"),
  );
  const { sha256Hex } = await hasher.sha256(streamOf(bytesOf("içerik")));
  const stat = await quarantine.put("temporary/sha", "içerik", { ...PUT_OPTIONS, contentSha256Hex: sha256Hex });
  assert.equal(stat.providerChecksumSha256, sha256Hex);
});

// ---------------------------------------------------------------------------
// Multipart yaşam döngüsü.
// ---------------------------------------------------------------------------

test("multipart parçalar sırasız ve yeniden yüklenebilir; içerik birleşir", async () => {
  const { quarantine, hasher } = fixture();
  const partSize = 8;
  const partA = bytesOf("A".repeat(partSize));
  const partB = bytesOf("B".repeat(partSize));
  const partC = bytesOf("C".repeat(3));

  const upload = await quarantine.createMultipartUpload("quarantine/multi", PUT_OPTIONS);
  const second = await quarantine.uploadPart("quarantine/multi", upload, 2, partB);
  await quarantine.uploadPart("quarantine/multi", upload, 1, bytesOf("X".repeat(partSize)));
  const first = await quarantine.uploadPart("quarantine/multi", upload, 1, partA); // yeniden yükleme öncekini değiştirir
  const third = await quarantine.uploadPart("quarantine/multi", upload, 3, partC);

  const stat = await quarantine.completeMultipartUpload("quarantine/multi", upload, [second, third, first]);
  assert.equal(stat.size, partSize * 2 + 3);

  const body = await quarantine.get("quarantine/multi");
  assert.equal(await readText(body!.body), "A".repeat(partSize) + "B".repeat(partSize) + "CCC");

  // İçerik SHA kararı sağlayıcı checksum'ına dayanamaz: multipart'ta bileşiktir.
  const digest = await hasher.sha256((await quarantine.get("quarantine/multi"))!.body);
  assert.notEqual(stat.providerChecksumSha256, digest.sha256Hex);
});

test("eşit olmayan ara parça boyutu tamamlamada reddedilir", async () => {
  const { quarantine } = fixture();
  const upload = await quarantine.createMultipartUpload("quarantine/uneven", PUT_OPTIONS);
  const parts = [
    await quarantine.uploadPart("quarantine/uneven", upload, 1, bytesOf("A".repeat(8))),
    await quarantine.uploadPart("quarantine/uneven", upload, 2, bytesOf("B".repeat(5))),
    await quarantine.uploadPart("quarantine/uneven", upload, 3, bytesOf("C".repeat(8))),
  ];
  await assert.rejects(
    quarantine.completeMultipartUpload("quarantine/uneven", upload, parts),
    (error: unknown) => isObjectStorageError(error, "PART_SIZE_MISMATCH"),
  );
});

test("eski veya yinelenen multipart alındısı reddedilir", async () => {
  const { quarantine } = fixture();
  const upload = await quarantine.createMultipartUpload("quarantine/receipt", PUT_OPTIONS);
  const stale = await quarantine.uploadPart("quarantine/receipt", upload, 1, bytesOf("eski"));
  const current = await quarantine.uploadPart("quarantine/receipt", upload, 1, bytesOf("yeni"));
  await assert.rejects(
    quarantine.completeMultipartUpload("quarantine/receipt", upload, [stale]),
    (error: unknown) => isObjectStorageError(error, "PART_TOKEN_MISMATCH"),
  );
  await assert.rejects(
    quarantine.completeMultipartUpload("quarantine/receipt", upload, [current, current]),
    (error: unknown) => isObjectStorageError(error, "INVALID_ARGUMENT"),
  );
  await quarantine.completeMultipartUpload("quarantine/receipt", upload, [current]);
});

test("iptal edilen multipart oturumu tamamlanamaz ve nesne bırakmaz", async () => {
  const { quarantine } = fixture();
  const upload = await quarantine.createMultipartUpload("quarantine/abort", PUT_OPTIONS);
  const part = await quarantine.uploadPart("quarantine/abort", upload, 1, bytesOf("veri"));
  await quarantine.abortMultipartUpload("quarantine/abort", upload);
  await assert.rejects(
    quarantine.completeMultipartUpload("quarantine/abort", upload, [part]),
    (error: unknown) => isObjectStorageError(error, "UPLOAD_NOT_FOUND"),
  );
  assert.equal(await quarantine.get("quarantine/abort"), null);
});

// ---------------------------------------------------------------------------
// Asıl kasa: koşullu yazma ve terfi.
// ---------------------------------------------------------------------------

test("aynı asıl anahtara ikinci koşullu yazma reddedilir; ilk nesne değişmez", async () => {
  const { vaultWriter, vaultReader, hasher } = fixture();
  const first = await vaultWriter.putIfAbsent("original/dok-1", "ilk içerik", PUT_OPTIONS);
  await assert.rejects(
    vaultWriter.putIfAbsent("original/dok-1", "saldırgan içerik", PUT_OPTIONS),
    (error: unknown) => isObjectStorageError(error, "KEY_ALREADY_EXISTS"),
  );
  const after = await vaultReader.head("original/dok-1");
  assert.equal(after?.etag, first.etag, "ETag değişmemeli");
  assert.equal(after?.providerVersionId, first.providerVersionId, "sürüm değişmemeli");
  const digest = await hasher.sha256((await vaultReader.get("original/dok-1"))!.body);
  const expected = await hasher.sha256(streamOf(bytesOf("ilk içerik")));
  assert.equal(digest.sha256Hex, expected.sha256Hex, "içerik değişmemeli");
});

test("eşzamanlı koşullu yazmada yalnız bir çağrı kazanır", async () => {
  const { vaultWriter, vaultReader } = fixture();
  const results = await Promise.allSettled([
    vaultWriter.putIfAbsent("original/race", "birinci", PUT_OPTIONS),
    vaultWriter.putIfAbsent("original/race", "ikinci", PUT_OPTIONS),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected && isObjectStorageError(rejected.reason, "KEY_ALREADY_EXISTS"));
  assert.ok(await vaultReader.head("original/race"));
});

test("terfi karantinadan asıla içeriği koruyarak taşır; ikinci terfi reddedilir", async () => {
  const { quarantine, vaultWriter, vaultReader, hasher } = fixture();
  await quarantine.put("quarantine/aday", "doğrulanmış içerik", PUT_OPTIONS);
  const expected = await hasher.sha256((await quarantine.get("quarantine/aday"))!.body);

  await vaultWriter.promote("quarantine/aday", "original/dok-2", PUT_OPTIONS);
  const digest = await hasher.sha256((await vaultReader.get("original/dok-2"))!.body);
  assert.equal(digest.sha256Hex, expected.sha256Hex);

  // Kaynak karantina nesnesi terfiden sonra hâlâ yerinde; temizlik ayrı roldedir.
  assert.ok(await quarantine.head("quarantine/aday"));

  await assert.rejects(
    vaultWriter.promote("quarantine/aday", "original/dok-2", PUT_OPTIONS),
    (error: unknown) => isObjectStorageError(error, "KEY_ALREADY_EXISTS"),
  );
  await assert.rejects(
    vaultWriter.promote("quarantine/yok", "original/dok-3", PUT_OPTIONS),
    (error: unknown) => isObjectStorageError(error, "OBJECT_NOT_FOUND"),
  );
});

test("asıl kasa yazıcısında silme veya güncelleme metodu yoktur", async () => {
  const { vaultWriter } = fixture();
  const surface = new Set<string>();
  let prototype: object | null = Object.getPrototypeOf(vaultWriter);
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) surface.add(name);
    prototype = Object.getPrototypeOf(prototype);
  }
  assert.ok(!surface.has("delete"), "ImmutableVaultWriter silme sunmamalı");
  assert.ok(!surface.has("put"), "ImmutableVaultWriter koşulsuz yazma sunmamalı");
  assert.deepEqual(
    [...surface].filter((name) => name !== "constructor").sort(),
    ["promote", "putIfAbsent"],
    "asıl kasa yüzeyi yalnız koşullu yazmadan oluşmalı",
  );
});

// ---------------------------------------------------------------------------
// Envanter ve tasfiye rolleri.
// ---------------------------------------------------------------------------

test("envanter sayfalı listeler ve önekle daraltır", async () => {
  const { vaultWriter, vaultInventory } = fixture();
  for (const name of ["a", "b", "c", "d", "e"]) {
    await vaultWriter.putIfAbsent(`original/${name}`, name, PUT_OPTIONS);
  }
  await vaultWriter.putIfAbsent("access/x", "türev", PUT_OPTIONS);

  const firstPage = await vaultInventory.list({ prefix: "original/", limit: 2 });
  assert.deepEqual(firstPage.objects.map((object) => object.key), ["original/a", "original/b"]);
  assert.ok(firstPage.cursor);

  const secondPage = await vaultInventory.list({ prefix: "original/", limit: 2, cursor: firstPage.cursor! });
  assert.deepEqual(secondPage.objects.map((object) => object.key), ["original/c", "original/d"]);

  const lastPage = await vaultInventory.list({ prefix: "original/", limit: 2, cursor: secondPage.cursor! });
  assert.deepEqual(lastPage.objects.map((object) => object.key), ["original/e"]);
  assert.equal(lastPage.cursor, null);
});

test("staging silmesi asıl ad alanına ulaşamaz; tasfiye ayrı rolle çalışır", async () => {
  const { quarantine, vaultWriter, vaultReader, disposition } = fixture();
  await vaultWriter.putIfAbsent("original/korunan", "asıl", PUT_OPTIONS);
  await quarantine.delete("original/korunan"); // staging kendi ad alanında çalışır
  assert.ok(await vaultReader.head("original/korunan"), "asıl, staging silmesinden etkilenmemeli");
  await disposition.delete("original/korunan");
  assert.equal(await vaultReader.head("original/korunan"), null);
});

// ---------------------------------------------------------------------------
// Hata sözleşmesi.
// ---------------------------------------------------------------------------

test("hata kodları sabit sözleşmedir", () => {
  const error = new ObjectStorageError("KEY_ALREADY_EXISTS", "dolu");
  assert.equal(error.name, "ObjectStorageError");
  assert.equal(error.code, "KEY_ALREADY_EXISTS");
  assert.ok(isObjectStorageError(error));
  assert.ok(isObjectStorageError(error, "KEY_ALREADY_EXISTS"));
  assert.ok(!isObjectStorageError(error, "OBJECT_NOT_FOUND"));
  assert.ok(!isObjectStorageError(new Error("sıradan"), "KEY_ALREADY_EXISTS"));
});
