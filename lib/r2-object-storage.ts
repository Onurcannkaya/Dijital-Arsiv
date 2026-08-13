/**
 * F1.1 — Cloudflare R2 adaptörleri.
 *
 * R2'ye özgü tipler, `uploadId`/ETag belirteçleri, koşullar ve hata eşleme
 * yalnız bu dosyada bulunur (YOL_HARITASI_FAZLAR.md §F1.1). Sözleşmeler
 * `lib/object-storage.ts` içindedir ve sağlayıcı belirteçlerini opak taşır.
 *
 * Koşullu yazma: R2 `put`, `onlyIf: { etagDoesNotMatch: "*" }` ön koşulu
 * sağlanmadığında `null` döner; adaptör bunu `KEY_ALREADY_EXISTS` koduna
 * eşler. Gerçek sağlayıcı davranışı staging kabul koşusunda T-01 ile
 * kanıtlanır (FAZ_1_KANIT_REHBERI.md); sözleşme testi tek başına kanıt
 * sayılmaz.
 *
 * Terfi: R2 binding'inde sunucu tarafı kopya yoktur; `promote` kaynağı akışla
 * okuyup hedefe koşullu yazar. Kaynak ve hedef ADR-014 gereği ayrı kovalardır.
 */

import {
  ObjectStorageError,
  type ByteRange,
  type ImmutableVaultWriter,
  type MultipartUploadToken,
  type ObjectBody,
  type ObjectReader,
  type ObjectStat,
  type ObjectStorage,
  type ObjectStorageBody,
  type ObjectStorageHead,
  type ObjectStoragePutOptions,
  type ObjectStorageValue,
  type PutObjectOptions,
  type StagingStorage,
  type StorageInventory,
  type DispositionStorage,
  type UploadedPart,
} from "./object-storage.ts";

function providerFailure(operation: string, cause: unknown): ObjectStorageError {
  return new ObjectStorageError("PROVIDER_UNAVAILABLE", `Depolama sağlayıcısı ${operation} işlemini tamamlayamadı.`, { cause });
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** R2 nesne başlığını sağlayıcı bağımsız `ObjectStat` tipine eşler. */
function toObjectStat(object: R2Object): ObjectStat {
  const sha256 = object.checksums?.sha256;
  return {
    size: object.size,
    contentType: object.httpMetadata?.contentType ?? null,
    etag: object.etag ?? null,
    providerVersionId: object.version ?? null,
    providerChecksumSha256: sha256 ? toHex(sha256) : null,
    uploadedAt: object.uploaded?.toISOString() ?? null,
    customMetadata: object.customMetadata,
  };
}

function returnedRange(object: R2Object): { bodySize: number; range: { offset: number; length: number } | null } {
  /*
   * Gerçek R2 aralıksız get'te `range` alanını hiç doldurmaz. Miniflare
   * emülasyonu ise tam okumada bile bir aralık NESNESİ döndürür ve alanları
   * tanımsız bırakır; körü körüne hesaplamak NaN üretir ve terfi ile dosya
   * sunumundaki "tam gövde" doğrulamaları yerelde bu yüzden düşüyordu
   * ("Promoted vault object cannot be read in full"). Sonlu olmayan değerler
   * "istenmedi" sayılır ve nesnenin tamamını kapsayan aralık tam okumadır —
   * iki kural da her iki ortamda anlamsal olarak doğrudur; kısmi okuma
   * güvenceleri değişmez.
   */
  const range = object.range;
  if (!range) return { bodySize: object.size, range: null };
  if ("suffix" in range && Number.isFinite(range.suffix)) {
    const length = Math.min(Math.max(range.suffix, 0), object.size);
    if (length === object.size) return { bodySize: object.size, range: null };
    return { bodySize: length, range: { offset: object.size - length, length } };
  }
  const requested = range as { offset?: number; length?: number };
  const offset = Number.isFinite(requested.offset) ? Math.max(requested.offset as number, 0) : 0;
  const fallbackLength = Math.max(object.size - offset, 0);
  const length = Number.isFinite(requested.length)
    ? Math.min(Math.max(requested.length as number, 0), fallbackLength)
    : fallbackLength;
  if (offset === 0 && length === object.size) return { bodySize: object.size, range: null };
  return { bodySize: length, range: { offset, length } };
}

function normalizeCompletedParts(parts: UploadedPart[]): UploadedPart[] {
  if (!parts.length) throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart tamamlama için en az bir parça gerekir.");
  const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
  let previous = 0;
  for (const part of sorted) {
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10_000 || !part.token) {
      throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart parça alındısı geçersiz.");
    }
    if (part.partNumber === previous) {
      throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart parça numaraları benzersiz olmalıdır.");
    }
    previous = part.partNumber;
  }
  return sorted;
}

function providerStatus(cause: unknown): number | null {
  if (!cause || typeof cause !== "object") return null;
  const candidate = cause as { status?: unknown; statusCode?: unknown };
  const value = candidate.status ?? candidate.statusCode;
  return typeof value === "number" ? value : null;
}

function toPutOptions(options: PutObjectOptions): R2PutOptions {
  return {
    httpMetadata: { contentType: options.contentType },
    customMetadata: options.customMetadata,
    // Adaptör yalnız verilen SHA'yı iletir; hesaplama lib/content-hasher.ts işidir.
    sha256: options.contentSha256Hex,
  };
}

// ---------------------------------------------------------------------------
// v1 — ADR-012 adaptörü (mevcut rotalar taşınana kadar).
// ---------------------------------------------------------------------------

/** Cloudflare R2 adaptörü. R2'ye özgü çağrılar yalnız bu dosyada bulunur. */
export class R2ObjectStorage implements ObjectStorage {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

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

// ---------------------------------------------------------------------------
// v2 — rol adaptörleri.
// ---------------------------------------------------------------------------

export class R2ObjectReader implements ObjectReader {
  protected readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async get(key: string, options?: { range?: ByteRange }): Promise<ObjectBody | null> {
    let object: R2ObjectBody | null;
    try {
      object = await this.bucket.get(key, options?.range ? { range: options.range } : undefined);
    } catch (cause) {
      throw providerFailure("okuma", cause);
    }
    if (!object) return null;
    return { ...toObjectStat(object), ...returnedRange(object), body: object.body as ReadableStream<Uint8Array> };
  }

  async head(key: string): Promise<ObjectStat | null> {
    try {
      const object = await this.bucket.head(key);
      return object ? toObjectStat(object) : null;
    } catch (cause) {
      throw providerFailure("başlık okuma", cause);
    }
  }
}

export class R2StagingStorage extends R2ObjectReader implements StagingStorage {
  async put(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat> {
    try {
      const object = await this.bucket.put(key, value, toPutOptions(options));
      return toObjectStat(object);
    } catch (cause) {
      // R2, verilen sha256 ile içerik uyuşmazlığında yazmayı reddeder.
      if (options.contentSha256Hex && cause instanceof Error && /checksum|sha/i.test(cause.message)) {
        throw new ObjectStorageError("PRECONDITION_FAILED", "İçerik SHA-256 değeri sağlayıcı doğrulamasından geçmedi.", { cause });
      }
      throw providerFailure("yazma", cause);
    }
  }

  async createMultipartUpload(key: string, options: PutObjectOptions): Promise<MultipartUploadToken> {
    try {
      const upload = await this.bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: options.contentType },
        customMetadata: options.customMetadata,
      });
      return upload.uploadId;
    } catch (cause) {
      throw providerFailure("multipart başlatma", cause);
    }
  }

  async uploadPart(
    key: string,
    upload: MultipartUploadToken,
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  ): Promise<UploadedPart> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart parça numarası 1 ile 10000 arasında olmalıdır.");
    }
    try {
      const session = this.bucket.resumeMultipartUpload(key, upload);
      const part = await session.uploadPart(partNumber, value);
      return { partNumber: part.partNumber, token: part.etag };
    } catch (cause) {
      throw mapMultipartError("parça yükleme", cause);
    }
  }

  async completeMultipartUpload(
    key: string,
    upload: MultipartUploadToken,
    parts: UploadedPart[],
  ): Promise<ObjectStat> {
    const ordered = normalizeCompletedParts(parts);
    try {
      const session = this.bucket.resumeMultipartUpload(key, upload);
      const object = await session.complete(ordered.map((part) => ({ partNumber: part.partNumber, etag: part.token })));
      return toObjectStat(object);
    } catch (cause) {
      throw mapMultipartError("multipart tamamlama", cause);
    }
  }

  async abortMultipartUpload(key: string, upload: MultipartUploadToken): Promise<void> {
    try {
      const session = this.bucket.resumeMultipartUpload(key, upload);
      await session.abort();
    } catch (cause) {
      throw mapMultipartError("multipart iptali", cause);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.bucket.delete(key);
    } catch (cause) {
      throw providerFailure("silme", cause);
    }
  }
}

/** R2 multipart hatalarını sabit kodlara eşler; sağlayıcı metni sızdırılmaz. */
function mapMultipartError(operation: string, cause: unknown): ObjectStorageError {
  const message = cause instanceof Error ? cause.message : "";
  if (/does not exist|no such upload|already (?:aborted|completed)/i.test(message)) {
    return new ObjectStorageError("UPLOAD_NOT_FOUND", "Multipart oturumu bulunamadı veya kapatılmış.", { cause });
  }
  if (/part size|too small|must be the same size|entity.?too.?small/i.test(message)) {
    return new ObjectStorageError("PART_SIZE_MISMATCH", "Parça boyutları sağlayıcı kuralına uymuyor.", { cause });
  }
  if (/invalid.?part|etag|part token/i.test(message)) {
    return new ObjectStorageError("PART_TOKEN_MISMATCH", "Multipart parça alındısı yüklenen içerikle eşleşmiyor.", { cause });
  }
  return providerFailure(operation, cause);
}

export class R2ImmutableVaultWriter implements ImmutableVaultWriter {
  private readonly vault: R2Bucket;
  private readonly stagingReader: ObjectReader;

  /**
   * @param vault Asıl kasa kovası; ADR-014 gereği staging'den ayrıdır.
   * @param stagingReader `promote` kaynağını akışla okuyan salt-okunur rol.
   */
  constructor(vault: R2Bucket, stagingReader: ObjectReader) {
    this.vault = vault;
    this.stagingReader = stagingReader;
  }

  async putIfAbsent(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat> {
    let object: R2Object | null;
    try {
      object = await this.vault.put(key, value, {
        ...toPutOptions(options),
        onlyIf: { etagDoesNotMatch: "*" },
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (providerStatus(cause) === 412 || /precondition|etag.*match/i.test(message)) {
        throw new ObjectStorageError("KEY_ALREADY_EXISTS", "Asıl anahtar zaten dolu; üzerine yazılmaz.", { cause });
      }
      throw providerFailure("koşullu yazma", cause);
    }
    if (!object) {
      throw new ObjectStorageError("KEY_ALREADY_EXISTS", "Asıl anahtar zaten dolu; üzerine yazılmaz.");
    }
    return toObjectStat(object);
  }

  async promote(sourceKey: string, targetKey: string, options: PutObjectOptions): Promise<ObjectStat> {
    const source = await this.stagingReader.get(sourceKey);
    if (!source) {
      throw new ObjectStorageError("OBJECT_NOT_FOUND", "Terfi kaynağı karantina alanında bulunamadı.");
    }
    return await this.putIfAbsent(targetKey, source.body, options);
  }
}

export class R2StorageInventory implements StorageInventory {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    let listing: R2Objects;
    try {
      listing = await this.bucket.list({
        prefix: options?.prefix,
        cursor: options?.cursor,
        limit: options?.limit,
      });
    } catch (cause) {
      throw providerFailure("listeleme", cause);
    }
    return {
      objects: listing.objects.map((object) => ({ key: object.key, ...toObjectStat(object) })),
      cursor: listing.truncated ? listing.cursor ?? null : null,
    };
  }
}

export class R2DispositionStorage implements DispositionStorage {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.bucket.delete(key);
    } catch (cause) {
      throw providerFailure("tasfiye silmesi", cause);
    }
  }
}
