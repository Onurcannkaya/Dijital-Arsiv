/**
 * Kurum içi port — lokal geliştirme için dosya sistemi nesne depolama sürücüsü.
 *
 * `lib/object-storage.ts` rol sözleşmelerini yerel diskte karşılar; MinIO/S3
 * ya da Docker gerektirmeden `node server/main.ts` ile tüm kabul hattının
 * dizüstünde çalışmasını sağlar. YALNIZ geliştirme/deneme içindir: kabul
 * kanıtı ve üretim daima gerçek S3/MinIO adaptörünü kullanır
 * (`lib/node-s3-object-storage.ts`). Node önyüklemesi bu sürücüyü yalnız
 * `ARCHIVE_STORAGE_DRIVER=local` olduğunda bağlar.
 *
 * Davranış eşliği: S3/R2 adaptörleriyle aynı hata kodları ve `putIfAbsent`
 * koşullu ilk yazma sözleşmesi (ADR-016) korunur. Her nesne, baytları taşıyan
 * bir dosya ve yanındaki `.meta.json` (içerik türü, özel üst veri, SHA-256,
 * sürüm, ETag, yükleme zamanı) ile temsil edilir. Anahtarlar düz bir dizinde
 * URL-güvenli kodlanır; yol kaçışı imkânsızdır.
 */

import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import {
  mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ObjectStorageError,
  type ByteRange,
  type DispositionStorage,
  type ImmutableVaultWriter,
  type MultipartUploadToken,
  type ObjectBody,
  type ObjectReader,
  type ObjectStat,
  type ObjectStorageValue,
  type PutObjectOptions,
  type StagingStorage,
  type StorageInventory,
  type UploadedPart,
} from "./object-storage.ts";
import {
  RoleBackedObjectStorage, makeStorageNamespace, type StorageNamespaceHandle,
} from "./storage-roles.ts";

type ObjectMeta = {
  contentType: string;
  customMetadata?: Record<string, string>;
  sha256: string;
  byteSize: number;
  versionId: string;
  etag: string;
  uploadedAt: string;
};

function encodeKey(key: string): string {
  // Anahtarın tamamı tek güvenli dosya adına kodlanır: yol kaçışı ve alt dizin
  // çakışması imkânsızdır. Boş anahtar (kova kökü) da güvenle temsil edilir.
  return Buffer.from(key, "utf8").toString("base64url") || "_root_";
}

async function collectStream(value: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = value.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function toBytes(value: ObjectStorageValue): Promise<Uint8Array> {
  if (value instanceof ReadableStream) return collectStream(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(Buffer.from(bytes))) as ReadableStream<Uint8Array>;
}

/** Tek kova = tek dizin. Bütün roller bu sınıfın örneğini paylaşır. */
export class LocalFsStorage {
  private readonly objectsDir: string;
  private readonly partsDir: string;
  private readonly uploads = new Map<string, { key: string; contentType: string; customMetadata?: Record<string, string> }>();

  constructor(root: string) {
    this.objectsDir = join(root, "objects");
    this.partsDir = join(root, "parts");
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(this.partsDir, { recursive: true });
  }

  private bytePath(key: string): string {
    return join(this.objectsDir, encodeKey(key));
  }

  private metaPath(key: string): string {
    return `${join(this.objectsDir, encodeKey(key))}.meta.json`;
  }

  private readMeta(key: string): ObjectMeta | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(key), "utf8")) as ObjectMeta;
    } catch {
      return null;
    }
  }

  private buildStat(meta: ObjectMeta): ObjectStat {
    return {
      size: meta.byteSize,
      contentType: meta.contentType,
      etag: meta.etag,
      providerVersionId: meta.versionId,
      providerChecksumSha256: meta.sha256,
      uploadedAt: meta.uploadedAt,
      customMetadata: meta.customMetadata,
    };
  }

  private persist(key: string, bytes: Uint8Array, options: PutObjectOptions): ObjectMeta {
    const sha256 = sha256Hex(bytes);
    if (options.contentSha256Hex && options.contentSha256Hex.toLowerCase() !== sha256) {
      throw new ObjectStorageError("PRECONDITION_FAILED", "İçerik SHA-256 değeri sağlayıcı doğrulamasından geçmedi.");
    }
    const meta: ObjectMeta = {
      contentType: options.contentType,
      customMetadata: options.customMetadata,
      sha256,
      byteSize: bytes.byteLength,
      versionId: randomUUID(),
      etag: sha256.slice(0, 32),
      uploadedAt: new Date().toISOString(),
    };
    // Baytları önce geçici dosyaya yazıp atomik taşı: yarım nesne görünmez.
    const tmp = join(this.objectsDir, `.tmp-${randomUUID()}`);
    writeFileSync(tmp, Buffer.from(bytes));
    renameSync(tmp, this.bytePath(key));
    writeFileSync(this.metaPath(key), JSON.stringify(meta));
    return meta;
  }

  async get(key: string, options?: { range?: ByteRange }): Promise<ObjectBody | null> {
    const meta = this.readMeta(key);
    if (!meta) return null;
    const stat = this.buildStat(meta);
    const full = await readFile(this.bytePath(key));
    if (options?.range) {
      const offset = Math.max(0, options.range.offset);
      const length = options.range.length ?? full.byteLength - offset;
      const slice = new Uint8Array(full.buffer, full.byteOffset + offset, Math.min(length, full.byteLength - offset));
      return { ...stat, body: streamOf(slice), bodySize: slice.byteLength, range: { offset, length: slice.byteLength } };
    }
    const bytes = new Uint8Array(full.buffer, full.byteOffset, full.byteLength);
    return { ...stat, body: streamOf(bytes), bodySize: bytes.byteLength, range: null };
  }

  async head(key: string): Promise<ObjectStat | null> {
    const meta = this.readMeta(key);
    return meta ? this.buildStat(meta) : null;
  }

  async put(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat> {
    return this.buildStat(this.persist(key, await toBytes(value), options));
  }

  async putIfAbsent(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat> {
    const bytes = await toBytes(value);
    const sha256 = sha256Hex(bytes);
    if (options.contentSha256Hex && options.contentSha256Hex.toLowerCase() !== sha256) {
      throw new ObjectStorageError("PRECONDITION_FAILED", "İçerik SHA-256 değeri sağlayıcı doğrulamasından geçmedi.");
    }
    const meta: ObjectMeta = {
      contentType: options.contentType,
      customMetadata: options.customMetadata,
      sha256,
      byteSize: bytes.byteLength,
      versionId: randomUUID(),
      etag: sha256.slice(0, 32),
      uploadedAt: new Date().toISOString(),
    };
    // `wx`: dosya varsa EEXIST → koşullu ilk yazma sözleşmesi (ADR-016).
    let handle;
    try {
      handle = await open(this.bytePath(key), "wx");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ObjectStorageError("KEY_ALREADY_EXISTS", "Asıl anahtar zaten dolu; üzerine yazılmaz.");
      }
      throw new ObjectStorageError("PROVIDER_UNAVAILABLE", "Yerel depolama yazma hatası.", { cause });
    }
    try {
      await handle.writeFile(Buffer.from(bytes));
    } finally {
      await handle.close();
    }
    await writeFile(this.metaPath(key), JSON.stringify(meta));
    return this.buildStat(meta);
  }

  async promote(sourceKey: string, targetKey: string, options: PutObjectOptions): Promise<ObjectStat> {
    const source = this.readMeta(sourceKey);
    if (!source) throw new ObjectStorageError("OBJECT_NOT_FOUND", "Terfi kaynağı karantina alanında bulunamadı.");
    const bytes = await readFile(this.bytePath(sourceKey));
    return this.putIfAbsent(targetKey, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), options);
  }

  async createMultipartUpload(key: string, options: PutObjectOptions): Promise<MultipartUploadToken> {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key, contentType: options.contentType, customMetadata: options.customMetadata });
    mkdirSync(join(this.partsDir, uploadId), { recursive: true });
    return uploadId;
  }

  async uploadPart(
    key: string,
    upload: MultipartUploadToken,
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
  ): Promise<UploadedPart> {
    if (!this.uploads.has(upload)) throw new ObjectStorageError("UPLOAD_NOT_FOUND", "Multipart oturumu bulunamadı.");
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart parça numarası 1 ile 10000 arasında olmalıdır.");
    }
    const bytes = await toBytes(value as ObjectStorageValue);
    writeFileSync(join(this.partsDir, upload, String(partNumber).padStart(5, "0")), Buffer.from(bytes));
    return { partNumber, token: sha256Hex(bytes).slice(0, 32) };
  }

  async completeMultipartUpload(key: string, upload: MultipartUploadToken, parts: UploadedPart[]): Promise<ObjectStat> {
    const session = this.uploads.get(upload);
    if (!session) throw new ObjectStorageError("UPLOAD_NOT_FOUND", "Multipart oturumu bulunamadı.");
    if (!parts.length) throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart tamamlama için en az bir parça gerekir.");
    const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber);
    const buffers = ordered.map((part) => readFileSync(join(this.partsDir, upload, String(part.partNumber).padStart(5, "0"))));
    const merged = Buffer.concat(buffers);
    const stat = this.persist(key, new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength), {
      contentType: session.contentType, customMetadata: session.customMetadata,
    });
    rmSync(join(this.partsDir, upload), { recursive: true, force: true });
    this.uploads.delete(upload);
    return this.buildStat(stat);
  }

  async abortMultipartUpload(key: string, upload: MultipartUploadToken): Promise<void> {
    rmSync(join(this.partsDir, upload), { recursive: true, force: true });
    this.uploads.delete(upload);
  }

  async delete(key: string): Promise<void> {
    await rm(this.bytePath(key), { force: true });
    await rm(this.metaPath(key), { force: true });
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    let names: string[];
    try {
      names = readdirSync(this.objectsDir).filter((name) => name.endsWith(".meta.json"));
    } catch {
      names = [];
    }
    const entries = names
      .map((name) => {
        const key = Buffer.from(name.slice(0, -".meta.json".length), "base64url").toString("utf8");
        return key === "_root_" ? "" : key;
      })
      .filter((key) => !options?.prefix || key.startsWith(options.prefix))
      .sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const limit = options?.limit ?? 1000;
    const page = entries.slice(start, start + limit);
    const objects = page.map((key) => ({ key, ...this.buildStat(this.readMeta(key) as ObjectMeta) }));
    const next = start + limit;
    return { objects, cursor: next < entries.length ? String(next) : null };
  }
}

/**
 * Tek `LocalFsStorage` örneği bütün rolleri karşılar; rol yüzeyleri sözleşme
 * tiplerine uyacak biçimde nesne olarak sarılır (parametre özelliği kullanmaz
 * — Node strip-only TS bunu desteklemez).
 */
export function createLocalFsNamespace(root: string): StorageNamespaceHandle {
  const store = new LocalFsStorage(root);
  const reader: ObjectReader = {
    get: (key, options) => store.get(key, options),
    head: (key) => store.head(key),
  };
  const staging: StagingStorage = {
    get: (key, options) => store.get(key, options),
    head: (key) => store.head(key),
    put: (key, value, options) => store.put(key, value, options),
    createMultipartUpload: (key, options) => store.createMultipartUpload(key, options),
    uploadPart: (key, upload, partNumber, value) => store.uploadPart(key, upload, partNumber, value),
    completeMultipartUpload: (key, upload, parts) => store.completeMultipartUpload(key, upload, parts),
    abortMultipartUpload: (key, upload) => store.abortMultipartUpload(key, upload),
    delete: (key) => store.delete(key),
  };
  const inventory: StorageInventory = { list: (options) => store.list(options) };
  const disposition: DispositionStorage = { delete: (key) => store.delete(key) };
  const vaultWriter: ImmutableVaultWriter = {
    putIfAbsent: (key, value, options) => store.putIfAbsent(key, value, options),
    promote: (sourceKey, targetKey, options) => store.promote(sourceKey, targetKey, options),
  };
  return makeStorageNamespace({
    reader,
    staging,
    inventory,
    disposition,
    objectStorage: new RoleBackedObjectStorage(reader, staging, inventory),
    vaultWriter: () => vaultWriter,
  });
}
