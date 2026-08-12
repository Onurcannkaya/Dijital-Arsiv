/**
 * Kurum içi port P4 — depolama bağlamasından rol adaptörü üreten dikiş.
 *
 * Kod tabanındaki bütün "new R2ObjectReader(bindings.X)" kurulum noktaları bu
 * modülün fabrika fonksiyonlarına taşınmıştır. Bağlama iki biçimde gelebilir:
 *
 * - Workers (pilot): ham `R2Bucket` — fonksiyonlar R2 rol sınıflarını sarar,
 *   davranış birebir aynı kalır.
 * - Node (kurum içi): `makeStorageNamespace` ile üretilmiş marka damgalı rol
 *   paketi — Node önyüklemesi (lib/node-runtime.ts) MinIO/S3 adaptörlerini bu
 *   pakete koyar. Bu modül S3 adaptörünü İÇE AKTARMAZ; Workers paketine Node
 *   modülü sızmaz.
 */

import {
  type DispositionStorage,
  type ImmutableVaultWriter,
  type ObjectBody,
  type ObjectReader,
  type ObjectStorage,
  type ObjectStorageBody,
  type ObjectStorageHead,
  type ObjectStoragePutOptions,
  type ObjectStorageValue,
  type StagingStorage,
  type StorageInventory,
} from "./object-storage.ts";
import {
  R2DispositionStorage, R2ImmutableVaultWriter, R2ObjectReader,
  R2ObjectStorage, R2StagingStorage, R2StorageInventory,
} from "./r2-object-storage.ts";

const NAMESPACE_BRAND = "sivas-arsiv/storage-namespace-v1";

/** Çalışma zamanının hazır rol paketi; Node önyüklemesi üretir. */
export type StorageNamespaceHandle = {
  __storageNamespace: typeof NAMESPACE_BRAND;
  reader: ObjectReader;
  staging: StagingStorage;
  inventory: StorageInventory;
  disposition: DispositionStorage;
  objectStorage: ObjectStorage;
  vaultWriter(stagingReader: ObjectReader): ImmutableVaultWriter;
};

/** Bağlama tipi: pilotta ham R2 kovası, kurum içinde rol paketi. */
export type StorageBinding = R2Bucket | StorageNamespaceHandle;

export function isStorageNamespaceHandle(
  binding: StorageBinding | null | undefined,
): binding is StorageNamespaceHandle {
  return Boolean(binding) && (binding as StorageNamespaceHandle).__storageNamespace === NAMESPACE_BRAND;
}

export function makeStorageNamespace(
  roles: Omit<StorageNamespaceHandle, "__storageNamespace">,
): StorageNamespaceHandle {
  return { __storageNamespace: NAMESPACE_BRAND, ...roles };
}

export function storageReader(binding: StorageBinding): ObjectReader {
  return isStorageNamespaceHandle(binding) ? binding.reader : new R2ObjectReader(binding);
}

export function storageStaging(binding: StorageBinding): StagingStorage {
  return isStorageNamespaceHandle(binding) ? binding.staging : new R2StagingStorage(binding);
}

export function storageVaultWriter(
  vault: StorageBinding,
  stagingReader: ObjectReader,
): ImmutableVaultWriter {
  return isStorageNamespaceHandle(vault)
    ? vault.vaultWriter(stagingReader)
    : new R2ImmutableVaultWriter(vault, stagingReader);
}

export function storageInventory(binding: StorageBinding): StorageInventory {
  return isStorageNamespaceHandle(binding) ? binding.inventory : new R2StorageInventory(binding);
}

export function storageDisposition(binding: StorageBinding): DispositionStorage {
  return isStorageNamespaceHandle(binding) ? binding.disposition : new R2DispositionStorage(binding);
}

/** ADR-012 v1 arayüzü; sağlık denetimi ve OCR okuma yolu kullanır. */
export function storageObjectStorage(binding: StorageBinding): ObjectStorage {
  return isStorageNamespaceHandle(binding) ? binding.objectStorage : new R2ObjectStorage(binding);
}

async function bufferStream(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * v1 `ObjectStorage` arayüzünü v2 rollerinin üzerine kurar; Node çalışma
 * zamanının rol paketi bunu kullanır. `arrayBuffer()` tembeldir: yalnız v1
 * tüketicisi tam gövde istediğinde akış tamponlanır.
 */
export class RoleBackedObjectStorage implements ObjectStorage {
  private readonly reader: ObjectReader;
  private readonly staging: StagingStorage;
  private readonly inventory: StorageInventory;

  constructor(reader: ObjectReader, staging: StagingStorage, inventory: StorageInventory) {
    this.reader = reader;
    this.staging = staging;
    this.inventory = inventory;
  }

  async get(key: string): Promise<ObjectStorageBody | null> {
    const object = await this.reader.get(key);
    if (!object) return null;
    return adaptV1Body(object);
  }

  async head(key: string): Promise<ObjectStorageHead | null> {
    const stat = await this.reader.head(key);
    return stat ? { size: stat.size, customMetadata: stat.customMetadata } : null;
  }

  async put(key: string, value: ObjectStorageValue, options: ObjectStoragePutOptions): Promise<void> {
    await this.staging.put(key, value, {
      contentType: options.contentType,
      customMetadata: options.customMetadata,
    });
  }

  async delete(key: string): Promise<void> {
    await this.staging.delete(key);
  }

  async check(): Promise<void> {
    await this.inventory.list({ limit: 1 });
  }
}

function adaptV1Body(object: ObjectBody): ObjectStorageBody {
  let buffered: Promise<ArrayBuffer> | null = null;
  return {
    body: object.body,
    size: object.size,
    customMetadata: object.customMetadata,
    arrayBuffer() {
      // Gövde akışı tek kullanımlıktır; ikinci çağrı aynı tamponu paylaşır.
      buffered ??= bufferStream(object.body);
      return buffered;
    },
  };
}
