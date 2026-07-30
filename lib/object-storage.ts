/**
 * ADR-012 + F1.1 — Nesne depolama sözleşmeleri.
 *
 * Uygulama katmanı sağlayıcı SDK tiplerine doğrudan bağlanmaz. Bu dosya yalnız
 * sağlayıcıdan ve çalışma zamanından bağımsız sözleşmeleri içerir; R2'ye özgü
 * adaptörler `lib/r2-object-storage.ts` içindedir. D1 içindeki `binary_objects`
 * tablosu nesnelerin yetkili listesidir; bu arayüzler yalnız baytların
 * saklandığı kasayı temsil eder.
 *
 * F1.1 rol ayrımı (YOL_HARITASI_FAZLAR.md §F1.1, ADR-014, ADR-016):
 * tek geniş arayüz yerine yetenekleri ayrılmış roller tanımlanır. Asıl kasa
 * yazıcısında silme metodu bilinçli olarak YOKTUR; tasfiye ayrı sözleşmedir ve
 * normal uygulama kimliğine bağlanmaz.
 */

// ---------------------------------------------------------------------------
// v1 — ADR-012 geriye dönük sözleşme.
// Mevcut rotalar F1.3–F1.5 ile rol sözleşmelerine taşınana kadar korunur.
// ---------------------------------------------------------------------------

export type ObjectStorageBody = {
  body: ReadableStream<Uint8Array>;
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
  | ReadableStream<Uint8Array>
  | string;

export interface ObjectStorage {
  get(key: string): Promise<ObjectStorageBody | null>;
  head(key: string): Promise<ObjectStorageHead | null>;
  put(key: string, value: ObjectStorageValue, options: ObjectStoragePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  check(): Promise<void>;
}

// ---------------------------------------------------------------------------
// v2 — ortak tipler ve hata sözleşmesi.
// ---------------------------------------------------------------------------

/** Sabit, sağlayıcıdan bağımsız hata kodları. Kullanıcıya sağlayıcı hatası sızdırılmaz. */
export type StorageErrorCode =
  | "KEY_ALREADY_EXISTS"
  | "OBJECT_NOT_FOUND"
  | "UPLOAD_NOT_FOUND"
  | "PART_SIZE_MISMATCH"
  | "PART_TOKEN_MISMATCH"
  | "INVALID_ARGUMENT"
  | "PRECONDITION_FAILED"
  | "CAPABILITY_UNSUPPORTED"
  | "PROVIDER_UNAVAILABLE";

export class ObjectStorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ObjectStorageError";
    this.code = code;
  }
}

export function isObjectStorageError(error: unknown, code?: StorageErrorCode): error is ObjectStorageError {
  return error instanceof ObjectStorageError && (code === undefined || error.code === code);
}

/** Aralıklı okuma isteği; `length` verilmezse nesne sonuna kadar okunur. */
export type ByteRange = { offset: number; length?: number };

/**
 * Sağlayıcının nesne için raporladığı durum.
 *
 * `etag` ve `providerVersionId` yardımcı alanlardır; taşınabilir bütünlük
 * kanıtı DEĞİLDİR (ADR-017). `providerChecksumSha256` multipart yüklemede
 * bileşik olabilir; içerik SHA-256 kararı her durumda uygulamanın akışlı
 * hesabıyla verilir (`lib/content-hasher.ts`).
 */
export type ObjectStat = {
  size: number;
  contentType: string | null;
  etag: string | null;
  providerVersionId: string | null;
  providerChecksumSha256: string | null;
  customMetadata?: Record<string, string>;
};

export type ObjectBody = ObjectStat & {
  body: ReadableStream<Uint8Array>;
  /** Bu yanıtta dönen gövde boyutu; aralıklı okumada `size` değerinden küçüktür. */
  bodySize: number;
  /** Tam okumada `null`, aralıklı okumada dönen normalize edilmiş byte aralığı. */
  range: { offset: number; length: number } | null;
};

export type PutObjectOptions = {
  contentType: string;
  customMetadata?: Record<string, string>;
  /**
   * Uygulamanın akışlı hesapladığı içerik SHA-256 (hex). Tek parça yazmada
   * sağlayıcıya doğrulama için iletilir; adaptör yalnız iletir, hesaplamaz.
   * Multipart tamamlamada sağlayıcılar bu alanı sunmaz (bileşik checksum);
   * bu yüzden multipart sözleşmesinde bulunmaz.
   */
  contentSha256Hex?: string;
};

/** Sağlayıcı multipart oturum belirteci; uygulama için opaktır. */
export type MultipartUploadToken = string;

/** Sağlayıcının parça alındısı (ör. parça ETag'i); uygulama için opaktır. */
export type UploadedPart = { partNumber: number; token: string };

// ---------------------------------------------------------------------------
// v2 — rol sözleşmeleri.
// ---------------------------------------------------------------------------

/** Akışlı ve aralıklı okuma. Tam dosya tamponlama API'si bilinçli olarak yok. */
export interface ObjectReader {
  get(key: string, options?: { range?: ByteRange }): Promise<ObjectBody | null>;
  head(key: string): Promise<ObjectStat | null>;
}

/**
 * Geçici/karantina alanı: multipart yaşam döngüsü ve yalnız bu alanla sınırlı
 * silme. ADR-014 gereği `TEMPORARY_FILES`/`QUARANTINE_FILES` yetki alanlarına
 * bağlanır; asıl kasaya bu rolle erişilmez.
 */
export interface StagingStorage extends ObjectReader {
  put(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat>;
  createMultipartUpload(key: string, options: PutObjectOptions): Promise<MultipartUploadToken>;
  uploadPart(
    key: string,
    upload: MultipartUploadToken,
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  ): Promise<UploadedPart>;
  completeMultipartUpload(
    key: string,
    upload: MultipartUploadToken,
    parts: UploadedPart[],
  ): Promise<ObjectStat>;
  abortMultipartUpload(key: string, upload: MultipartUploadToken): Promise<void>;
  /** Yalnız geçici/karantina yaşam döngüsü temizliği; asıl bu rolle silinemez. */
  delete(key: string): Promise<void>;
}

/**
 * Asıl kasa yazıcısı. Yalnız koşullu ilk yazma vardır; `delete`, `get` veya
 * güncelleme metodu bilinçli olarak tanımlı değildir (ADR-016). Var olan
 * anahtara yazma `KEY_ALREADY_EXISTS` ile başarısız olur.
 */
export interface ImmutableVaultWriter {
  putIfAbsent(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat>;
  /**
   * Doğrulanmış karantina nesnesini asıl anahtarına if-absent koşuluyla terfi
   * ettirir. Kaynak nesne değişmez; temizliği ayrı yaşam döngüsü rolü yapar.
   */
  promote(sourceKey: string, targetKey: string, options: PutObjectOptions): Promise<ObjectStat>;
}

/** Sayfalı envanter; bütünlük taraması ve uzlaştırma bu rolü kullanır. */
export interface StorageInventory {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string } & ObjectStat>;
    cursor: string | null;
  }>;
}

/**
 * Tasfiye yetkisi (ADR-016 §Tasfiye). Normal uygulama kimliğinde BULUNMAZ;
 * kurul/onay süreci ve dört göz ilkesiyle, ayrı kimlik üzerinden bağlanır.
 */
export interface DispositionStorage {
  delete(key: string): Promise<void>;
}
