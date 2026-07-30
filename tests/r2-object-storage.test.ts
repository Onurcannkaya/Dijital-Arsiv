import assert from "node:assert/strict";
import test from "node:test";

import { isObjectStorageError } from "../lib/object-storage.ts";
import {
  R2ImmutableVaultWriter,
  R2ObjectReader,
  R2StagingStorage,
} from "../lib/r2-object-storage.ts";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function r2Object(overrides: Partial<R2ObjectBody> = {}): R2ObjectBody {
  return {
    key: "object",
    version: "version-1",
    size: 10,
    etag: "etag-1",
    httpEtag: "\"etag-1\"",
    checksums: {},
    uploaded: new Date("2026-07-30T00:00:00Z"),
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { sha256: "a".repeat(64) },
    storageClass: "Standard",
    writeHttpMetadata() {},
    body: streamOf("234"),
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    bytes: async () => new Uint8Array(),
    text: async () => "",
    json: async <T>() => ({}) as T,
    blob: async () => new Blob(),
    ...overrides,
  } as R2ObjectBody;
}

test("R2 okuyucu sağlayıcı başlığını ve aralık gövde boyutunu normalize eder", async () => {
  const bucket = {
    get: async () => r2Object({ range: { offset: 2, length: 3 } }),
  } as unknown as R2Bucket;
  const result = await new R2ObjectReader(bucket).get("object", { range: { offset: 2, length: 3 } });
  assert.ok(result);
  assert.equal(result.size, 10);
  assert.equal(result.bodySize, 3);
  assert.deepEqual(result.range, { offset: 2, length: 3 });
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.providerVersionId, "version-1");
});

test("R2 multipart tamamlama alındıları sıralar ve yinelenen parçayı reddeder", async () => {
  let completedParts: R2UploadedPart[] = [];
  const bucket = {
    resumeMultipartUpload: () => ({
      complete: async (parts: R2UploadedPart[]) => {
        completedParts = parts;
        return r2Object();
      },
    }),
  } as unknown as R2Bucket;
  const staging = new R2StagingStorage(bucket);
  await staging.completeMultipartUpload("object", "upload", [
    { partNumber: 2, token: "etag-2" },
    { partNumber: 1, token: "etag-1" },
  ]);
  assert.deepEqual(completedParts.map((part) => part.partNumber), [1, 2]);
  await assert.rejects(
    staging.completeMultipartUpload("object", "upload", [
      { partNumber: 1, token: "etag-1" },
      { partNumber: 1, token: "etag-1" },
    ]),
    (error: unknown) => isObjectStorageError(error, "INVALID_ARGUMENT"),
  );
});

test("R2 koşullu yazma null veya 412 sonucunu dolu anahtar hatasına eşler", async () => {
  const reader = { get: async () => null, head: async () => null };
  const nullBucket = { put: async () => null } as unknown as R2Bucket;
  await assert.rejects(
    new R2ImmutableVaultWriter(nullBucket, reader).putIfAbsent(
      "original/a",
      "içerik",
      { contentType: "application/pdf" },
    ),
    (error: unknown) => isObjectStorageError(error, "KEY_ALREADY_EXISTS"),
  );

  const preconditionBucket = {
    put: async () => {
      throw Object.assign(new Error("precondition failed"), { status: 412 });
    },
  } as unknown as R2Bucket;
  await assert.rejects(
    new R2ImmutableVaultWriter(preconditionBucket, reader).putIfAbsent(
      "original/a",
      "içerik",
      { contentType: "application/pdf" },
    ),
    (error: unknown) => isObjectStorageError(error, "KEY_ALREADY_EXISTS"),
  );
});
