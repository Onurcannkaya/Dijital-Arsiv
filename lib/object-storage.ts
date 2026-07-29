/**
 * ADR-012 — Nesne depolama sınırı.
 *
 * Uygulama katmanı R2Bucket API'sine doğrudan bağlanmaz. Böylece yerel pilotta
 * R2, kurum kurulumunda ise aynı sözleşmeyi uygulayan S3 uyumlu bir adaptör
 * kullanılabilir. D1 içindeki `binary_objects` tablosu nesnelerin yetkili
 * listesidir; bu arayüz yalnız baytların saklandığı kasayı temsil eder.
 */

export type ObjectStorageBody = {
  body: ReadableStream;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  customMetadata?: Record<string, string>;
};

export type ObjectStorageHead = {
  size: number;
  customMetadata?: Record<string, string>;
};

export type ObjectStoragePutOptions = {
  contentType: string;
  customMetadata?: Record<string, string>;
};

export type ObjectStorageValue =
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | ReadableStream
  | string;

export interface ObjectStorage {
  get(key: string): Promise<ObjectStorageBody | null>;
  head(key: string): Promise<ObjectStorageHead | null>;
  put(key: string, value: ObjectStorageValue, options: ObjectStoragePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  check(): Promise<void>;
}

/** Cloudflare R2 adaptörü. R2'ye özgü çağrılar yalnız bu sınıfta bulunur. */
export class R2ObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<ObjectStorageBody | null> {
    return await this.bucket.get(key);
  }

  async head(key: string): Promise<ObjectStorageHead | null> {
    return await this.bucket.head(key);
  }

  async put(key: string, value: ObjectStorageValue, options: ObjectStoragePutOptions): Promise<void> {
    await this.bucket.put(key, value, {
      httpMetadata: { contentType: options.contentType },
      customMetadata: options.customMetadata,
    });
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async check(): Promise<void> {
    await this.bucket.list({ limit: 1 });
  }
}

export function createObjectStorage(bucket: R2Bucket): ObjectStorage {
  return new R2ObjectStorage(bucket);
}
