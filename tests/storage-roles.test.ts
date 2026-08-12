/**
 * Kurum içi port P4 — depolama rol dikişi testleri.
 *
 * Ham R2 kovası R2 rol sınıflarına, marka damgalı rol paketi kendi
 * adaptörlerine yönlenmelidir; v1 ObjectStorage köprüsü v2 rolleri üzerinde
 * sağlık denetimi ve tam-gövde okuma sözleşmesini karşılamalıdır.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ObjectReader, StagingStorage, StorageInventory } from "../lib/object-storage.ts";
import { R2ObjectReader, R2StagingStorage } from "../lib/r2-object-storage.ts";
import {
  RoleBackedObjectStorage,
  isStorageNamespaceHandle,
  makeStorageNamespace,
  storageDisposition,
  storageInventory,
  storageObjectStorage,
  storageReader,
  storageStaging,
  storageVaultWriter,
} from "../lib/storage-roles.ts";
import {
  MemoryNamespace, MemoryObjectReader, MemoryStagingStorage,
} from "./memory-object-storage.ts";

const fakeBucket = {} as unknown as R2Bucket;

test("ham R2 kovası R2 rol sınıflarına sarılır", () => {
  assert.ok(storageReader(fakeBucket) instanceof R2ObjectReader);
  assert.ok(storageStaging(fakeBucket) instanceof R2StagingStorage);
  assert.equal(isStorageNamespaceHandle(fakeBucket), false);
});

test("rol paketi kendi adaptörlerini olduğu gibi döndürür", () => {
  const marker = <T,>(name: string) => ({ name }) as unknown as T;
  const reader = marker<ObjectReader>("reader");
  const staging = marker<StagingStorage>("staging");
  const inventory = marker<StorageInventory>("inventory");
  const handle = makeStorageNamespace({
    reader,
    staging,
    inventory,
    disposition: marker("disposition"),
    objectStorage: marker("objectStorage"),
    vaultWriter: (stagingReader) => marker(`vault:${(stagingReader as unknown as { name: string }).name}`),
  });
  assert.equal(isStorageNamespaceHandle(handle), true);
  assert.equal(storageReader(handle), reader);
  assert.equal(storageStaging(handle), staging);
  assert.equal(storageInventory(handle), inventory);
  assert.equal(storageDisposition(handle), handle.disposition);
  assert.equal(storageObjectStorage(handle), handle.objectStorage);
  // Kasa yazıcısı staging okuyucusunu paket fabrikasına iletir.
  const vault = storageVaultWriter(handle, reader) as unknown as { name: string };
  assert.equal(vault.name, "vault:reader");
});

test("v1 köprüsü v2 rolleri üzerinde yazma/okuma/sağlık sözleşmesini karşılar", async () => {
  const namespace = new MemoryNamespace(() => new Date("2026-08-11T10:00:00.000Z"));
  const staging = new MemoryStagingStorage(namespace);
  const reader = new MemoryObjectReader(namespace);
  const inventoryCalls: number[] = [];
  const inventory: StorageInventory = {
    async list(options) {
      inventoryCalls.push(options?.limit ?? 0);
      return { objects: [], cursor: null };
    },
  };
  const bridge = new RoleBackedObjectStorage(reader, staging, inventory);

  await bridge.put("v1/anahtar", "köprü içeriği", {
    contentType: "text/plain",
    customMetadata: { kaynak: "test" },
  });
  const body = await bridge.get("v1/anahtar");
  assert.ok(body);
  assert.equal(new TextDecoder().decode(await body.arrayBuffer()), "köprü içeriği");
  assert.equal(body.size, new TextEncoder().encode("köprü içeriği").byteLength);
  assert.equal(body.customMetadata?.kaynak, "test");
  const head = await bridge.head("v1/anahtar");
  assert.equal(head?.size, body.size);
  await bridge.check();
  assert.deepEqual(inventoryCalls, [1]);
  await bridge.delete("v1/anahtar");
  assert.equal(await bridge.head("v1/anahtar"), null);
});
