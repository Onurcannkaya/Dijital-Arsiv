/**
 * Kurum içi port P3 — S3/MinIO adaptörü sözleşme testleri.
 *
 * R2 adaptörüyle davranış eşliği hedeflenir: koşullu ilk yazma
 * `KEY_ALREADY_EXISTS`, içerik SHA reddi `PRECONDITION_FAILED`, multipart
 * hataları sabit kodlara eşlenir; büyük akışlar sınırlı bellekle iç
 * multipart'a dönüşür. Sahte sunucu MinIO yüzeyini modeller; gerçek sağlayıcı
 * kanıtı kabul koşusundadır (T-01/T-09/T-10).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { isObjectStorageError } from "../lib/object-storage.ts";
import {
  NodeS3DispositionStorage,
  NodeS3ImmutableVaultWriter,
  NodeS3ObjectReader,
  NodeS3StagingStorage,
  NodeS3StorageInventory,
  type NodeS3Config,
} from "../lib/node-s3-object-storage.ts";
import { fakeS3Server, type FakeS3Options } from "./node-s3-fake.ts";

const PUT_OPTIONS = { contentType: "application/pdf" };

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function harness(options: FakeS3Options & { internalPartBytes?: number } = {}) {
  const server = fakeS3Server(options);
  const config: NodeS3Config = {
    endpoint: "https://minio.internal",
    bucket: server.bucket,
    region: "auto",
    credentials: { accessKeyId: "port-test", secretAccessKey: "s".repeat(24) },
    fetcher: server.fetcher,
    internalPartBytes: options.internalPartBytes,
  };
  return {
    server,
    reader: new NodeS3ObjectReader(config),
    staging: new NodeS3StagingStorage(config),
    vault: new NodeS3ImmutableVaultWriter(config, new NodeS3StagingStorage(config)),
    inventory: new NodeS3StorageInventory(config),
    disposition: new NodeS3DispositionStorage(config),
  };
}

test("yazma/okuma turu: içerik, tür, özel üst veri ve stat alanları korunur", async () => {
  const { staging } = harness();
  const payload = bytesOf("kurum ici nesne");
  const written = await staging.put("temporary/s1/payload", payload, {
    contentType: "application/pdf",
    contentSha256Hex: sha256Hex(payload),
    customMetadata: { uploadsessionid: "s1", objectclass: "temporary" },
  });
  assert.equal(written.size, payload.byteLength);
  assert.equal(written.providerChecksumSha256, sha256Hex(payload));
  assert.ok(written.etag);

  const read = await staging.get("temporary/s1/payload");
  assert.ok(read);
  assert.deepEqual(await readAll(read.body), payload);
  assert.equal(read.size, payload.byteLength);
  assert.equal(read.bodySize, payload.byteLength);
  assert.equal(read.range, null);
  assert.equal(read.contentType, "application/pdf");
  assert.equal(read.customMetadata?.uploadsessionid, "s1");
  assert.equal(read.providerChecksumSha256, sha256Hex(payload));
  assert.ok(read.uploadedAt);

  const head = await staging.head("temporary/s1/payload");
  assert.equal(head?.size, payload.byteLength);
});

test("aralıklı okuma: bodySize, range ve toplam boyut doğru döner", async () => {
  const { staging, reader } = harness();
  await staging.put("k", bytesOf("0123456789"), PUT_OPTIONS);
  const middle = await reader.get("k", { range: { offset: 2, length: 5 } });
  assert.ok(middle);
  assert.deepEqual(await readAll(middle.body), bytesOf("23456"));
  assert.equal(middle.size, 10);
  assert.equal(middle.bodySize, 5);
  assert.deepEqual(middle.range, { offset: 2, length: 5 });

  const tail = await reader.get("k", { range: { offset: 7 } });
  assert.ok(tail);
  assert.deepEqual(await readAll(tail.body), bytesOf("789"));
  assert.deepEqual(tail.range, { offset: 7, length: 3 });
});

test("olmayan nesne için get/head null döner", async () => {
  const { reader } = harness();
  assert.equal(await reader.get("yok"), null);
  assert.equal(await reader.head("yok"), null);
});

test("yanlış içerik SHA'sı yazmayı PRECONDITION_FAILED ile reddeder", async () => {
  const { staging, reader } = harness();
  await assert.rejects(
    () => staging.put("bozuk", bytesOf("gercek icerik"), {
      contentType: "application/pdf",
      contentSha256Hex: "0".repeat(64),
    }),
    (error: unknown) => isObjectStorageError(error, "PRECONDITION_FAILED"),
  );
  assert.equal(await reader.head("bozuk"), null, "reddedilen yazma iz bırakmamalı");
});

test("multipart yaşam döngüsü: parçalar birleşir, iptal oturumu kapatır", async () => {
  const { staging } = harness();
  const upload = await staging.createMultipartUpload("multi", PUT_OPTIONS);
  const first = await staging.uploadPart("multi", upload, 1, bytesOf("birinci-"));
  const second = await staging.uploadPart("multi", upload, 2, streamOf(bytesOf("ikinci")));
  const stat = await staging.completeMultipartUpload("multi", upload, [second, first]);
  assert.equal(stat.size, bytesOf("birinci-ikinci").byteLength);
  const read = await staging.get("multi");
  assert.deepEqual(await readAll(read!.body), bytesOf("birinci-ikinci"));

  const abandoned = await staging.createMultipartUpload("iptal", PUT_OPTIONS);
  await staging.abortMultipartUpload("iptal", abandoned);
  await assert.rejects(
    () => staging.uploadPart("iptal", abandoned, 1, bytesOf("x")),
    (error: unknown) => isObjectStorageError(error, "UPLOAD_NOT_FOUND"),
  );
});

test("multipart hataları sabit kodlara eşlenir", async () => {
  const { staging } = harness({ minPartBytes: 8 });
  await assert.rejects(
    () => staging.uploadPart("multi", "olmayan-oturum", 1, bytesOf("x")),
    (error: unknown) => isObjectStorageError(error, "UPLOAD_NOT_FOUND"),
  );
  const upload = await staging.createMultipartUpload("multi", PUT_OPTIONS);
  const large = await staging.uploadPart("multi", upload, 1, bytesOf("gecerli-uzun-parca"));
  await assert.rejects(
    () => staging.completeMultipartUpload("multi", upload, [{ partNumber: 1, token: "sahte-etag" }]),
    (error: unknown) => isObjectStorageError(error, "PART_TOKEN_MISMATCH"),
  );
  // Son olmayan parça asgari boyutun altında: EntityTooSmall → PART_SIZE_MISMATCH.
  const small = await staging.uploadPart("multi", upload, 2, bytesOf("kucuk"));
  await assert.rejects(
    () => staging.completeMultipartUpload("multi", upload, [small, { partNumber: 3, token: large.token }]),
    (error: unknown) => isObjectStorageError(error, "PART_SIZE_MISMATCH"),
  );
});

test("koşullu ilk yazma: ikinci yazma KEY_ALREADY_EXISTS, içerik değişmez", async () => {
  const { vault, reader } = harness();
  await vault.putIfAbsent("originals/d1/o1", bytesOf("asil"), PUT_OPTIONS);
  await assert.rejects(
    () => vault.putIfAbsent("originals/d1/o1", bytesOf("saldirgan"), PUT_OPTIONS),
    (error: unknown) => isObjectStorageError(error, "KEY_ALREADY_EXISTS"),
  );
  const read = await reader.get("originals/d1/o1");
  assert.deepEqual(await readAll(read!.body), bytesOf("asil"));
});

test("promote: kaynak yoksa OBJECT_NOT_FOUND; varsa akışla koşullu kopyalanır", async () => {
  const { staging, vault, reader } = harness();
  await assert.rejects(
    () => vault.promote("quarantine/yok", "originals/hedef", PUT_OPTIONS),
    (error: unknown) => isObjectStorageError(error, "OBJECT_NOT_FOUND"),
  );
  await staging.put("quarantine/s2/payload", bytesOf("dogrulanmis icerik"), PUT_OPTIONS);
  const promoted = await vault.promote("quarantine/s2/payload", "originals/d2/o2", PUT_OPTIONS);
  assert.equal(promoted.size, bytesOf("dogrulanmis icerik").byteLength);
  const read = await reader.get("originals/d2/o2");
  assert.deepEqual(await readAll(read!.body), bytesOf("dogrulanmis icerik"));
});

test("büyük akış sınırlı bellekle iç multipart'a dönüşür; koşul tamamlamada korunur", async () => {
  const { staging, vault, reader, server } = harness({ internalPartBytes: 8 });
  const big = bytesOf("0123456789".repeat(5)); // 50 bayt > 8 baytlık iç parça
  await staging.put("buyuk", streamOf(big.subarray(0, 17), big.subarray(17)), PUT_OPTIONS);
  const read = await reader.get("buyuk");
  assert.deepEqual(await readAll(read!.body), big);
  assert.equal(read!.size, big.byteLength);
  // İç multipart oturumu geride kalmadı.
  assert.equal(server.uploads.size, 0);

  // Koşullu büyük yazma: hedef doluysa tamamlanma 412 ile düşer ve iz bırakmaz.
  await assert.rejects(
    () => vault.putIfAbsent("buyuk", streamOf(big), PUT_OPTIONS),
    (error: unknown) => isObjectStorageError(error, "KEY_ALREADY_EXISTS"),
  );
  assert.deepEqual(await readAll((await reader.get("buyuk"))!.body), big);
  assert.equal(server.uploads.size, 0, "başarısız koşullu yükleme iptal edilmeli");
});

test("envanter: önek süzer, sayfalama imleci ilerler", async () => {
  const { staging, inventory } = harness();
  for (const index of [1, 2, 3]) {
    await staging.put(`originals/a/${index}`, bytesOf(`icerik-${index}`), PUT_OPTIONS);
  }
  await staging.put("temporary/b/1", bytesOf("baska"), PUT_OPTIONS);

  const firstPage = await inventory.list({ prefix: "originals/", limit: 2 });
  assert.equal(firstPage.objects.length, 2);
  assert.ok(firstPage.cursor);
  const secondPage = await inventory.list({ prefix: "originals/", limit: 2, cursor: firstPage.cursor! });
  assert.equal(secondPage.objects.length, 1);
  assert.equal(secondPage.cursor, null);
  const keys = [...firstPage.objects, ...secondPage.objects].map((object) => object.key);
  assert.deepEqual(keys, ["originals/a/1", "originals/a/2", "originals/a/3"]);
  assert.ok(firstPage.objects[0].uploadedAt, "uzlaştırma genç-nesne toleransı uploadedAt ister");
});

test("tasfiye silmesi nesneyi kaldırır; staging silmesi idempotenttir", async () => {
  const { staging, disposition, reader } = harness();
  await staging.put("silinecek", bytesOf("x"), PUT_OPTIONS);
  await disposition.delete("silinecek");
  assert.equal(await reader.head("silinecek"), null);
  await staging.delete("zaten-yok"); // hata fırlatmamalı
});

test("düz HTTP ucu yalnız açık izinle kabul edilir", () => {
  const server = fakeS3Server();
  const base = {
    endpoint: "http://minio.internal:9000",
    bucket: server.bucket,
    credentials: { accessKeyId: "port-test", secretAccessKey: "s".repeat(24) },
    fetcher: server.fetcher,
  };
  assert.throws(
    () => new NodeS3ObjectReader(base),
    (error: unknown) => isObjectStorageError(error, "INVALID_ARGUMENT"),
  );
  assert.ok(new NodeS3ObjectReader({ ...base, allowHttp: true }));
});

test("sağlayıcı 5xx hatası PROVIDER_UNAVAILABLE koduna eşlenir", async () => {
  const { reader, staging } = harness({ failWithStatus: 503 });
  await assert.rejects(
    () => reader.get("herhangi"),
    (error: unknown) => isObjectStorageError(error, "PROVIDER_UNAVAILABLE"),
  );
  await assert.rejects(
    () => staging.put("herhangi", bytesOf("x"), PUT_OPTIONS),
    (error: unknown) => isObjectStorageError(error, "PROVIDER_UNAVAILABLE"),
  );
});
