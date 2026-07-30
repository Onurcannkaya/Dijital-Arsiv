/**
 * F1.1 — S3 uyumlu bellek-içi test adaptörü.
 *
 * Sözleşme paketinin sağlayıcıdan bağımsız çalıştığını kanıtlamak için S3/R2
 * anlamsallığını taklit eder:
 *
 * - koşullu ilk yazma (`putIfAbsent`) dolu anahtarı reddeder;
 * - multipart tamamlama, son parça hariç eşit parça boyutu ister (R2 kuralı);
 * - aynı parça numarasına yeniden yükleme öncekini değiştirir (S3 kuralı);
 * - tek parça yazmada bildirilen SHA-256 içerikle doğrulanır;
 * - multipart nesnenin sağlayıcı checksum'ı BİLEŞİKTİR ve içerik SHA'sına
 *   eşit değildir — uygulamanın sağlayıcı checksum'ına dayanmadığını test
 *   etmek için bilinçli böyledir.
 *
 * Karantina/asıl ayrımı için her depo ayrı ad alanıdır; `ImmutableVaultWriter`
 * kaynak okumayı yalnız verilen `ObjectReader` üzerinden yapar (ADR-014).
 */

import { createHash } from "node:crypto";

import {
  ObjectStorageError,
  type ByteRange,
  type ImmutableVaultWriter,
  type MultipartUploadToken,
  type ObjectBody,
  type ObjectReader,
  type ObjectStat,
  type ObjectStorageValue,
  type PutObjectOptions,
  type StagingStorage,
  type StorageInventory,
  type DispositionStorage,
  type UploadedPart,
} from "../lib/object-storage.ts";
import type { StreamDigest, StreamingHasher } from "../lib/content-hasher.ts";

type StoredEntry = {
  bytes: Uint8Array;
  contentType: string;
  customMetadata?: Record<string, string>;
  etag: string;
  providerVersionId: string;
  providerChecksumSha256: string | null;
  uploadedAt: string;
};

type MultipartSession = {
  key: string;
  options: PutObjectOptions;
  parts: Map<number, { bytes: Uint8Array; token: string }>;
  open: boolean;
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readAll(value: ObjectStorageValue | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  const chunks: Uint8Array[] = [];
  const reader = (value as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Tek parça yerine dilimleyerek sun: tüketici akış davranışını görsün.
      const chunkSize = 64 * 1024;
      for (let index = 0; index < bytes.byteLength; index += chunkSize) {
        controller.enqueue(bytes.subarray(index, Math.min(index + chunkSize, bytes.byteLength)));
      }
      controller.close();
    },
  });
}

/** Bellek-içi ad alanı; bir kova/namespace'e karşılık gelir. */
export class MemoryNamespace {
  readonly entries = new Map<string, StoredEntry>();
  readonly reservations = new Set<string>();
  private sequence = 0;
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  nextVersion(): { etag: string; providerVersionId: string; uploadedAt: string } {
    this.sequence += 1;
    return {
      etag: `"mem-${this.sequence}"`, providerVersionId: `v${this.sequence}`,
      uploadedAt: this.now().toISOString(),
    };
  }

  stat(key: string): ObjectStat | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return {
      size: entry.bytes.byteLength,
      contentType: entry.contentType,
      etag: entry.etag,
      providerVersionId: entry.providerVersionId,
      providerChecksumSha256: entry.providerChecksumSha256,
      uploadedAt: entry.uploadedAt,
      customMetadata: entry.customMetadata,
    };
  }
}

export class MemoryObjectReader implements ObjectReader {
  protected readonly namespace: MemoryNamespace;

  constructor(namespace: MemoryNamespace) {
    this.namespace = namespace;
  }

  async get(key: string, options?: { range?: ByteRange }): Promise<ObjectBody | null> {
    const entry = this.namespace.entries.get(key);
    const stat = this.namespace.stat(key);
    if (!entry || !stat) return null;
    let bytes = entry.bytes;
    let range: { offset: number; length: number } | null = null;
    if (options?.range) {
      const { offset, length } = options.range;
      if (!Number.isInteger(offset) || offset < 0 || offset > bytes.byteLength
        || (length !== undefined && (!Number.isInteger(length) || length < 0))) {
        throw new ObjectStorageError("INVALID_ARGUMENT", "Byte aralığı geçersiz.");
      }
      const end = length === undefined ? bytes.byteLength : Math.min(bytes.byteLength, offset + length);
      bytes = bytes.subarray(offset, end);
      range = { offset, length: bytes.byteLength };
    }
    return { ...stat, bodySize: bytes.byteLength, range, body: streamOf(bytes) };
  }

  async head(key: string): Promise<ObjectStat | null> {
    return this.namespace.stat(key);
  }
}

export class MemoryStagingStorage extends MemoryObjectReader implements StagingStorage {
  private readonly uploads = new Map<string, MultipartSession>();
  private uploadSequence = 0;

  async put(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat> {
    const bytes = await readAll(value);
    const actualSha = sha256Hex(bytes);
    if (options.contentSha256Hex && options.contentSha256Hex.toLowerCase() !== actualSha) {
      throw new ObjectStorageError("PRECONDITION_FAILED", "İçerik SHA-256 değeri sağlayıcı doğrulamasından geçmedi.");
    }
    const version = this.namespace.nextVersion();
    this.namespace.entries.set(key, {
      bytes,
      contentType: options.contentType,
      customMetadata: options.customMetadata,
      providerChecksumSha256: actualSha,
      ...version,
    });
    const stat = this.namespace.stat(key);
    if (!stat) throw new Error("beklenmeyen: yazılan nesne bulunamadı");
    return stat;
  }

  async createMultipartUpload(key: string, options: PutObjectOptions): Promise<MultipartUploadToken> {
    this.uploadSequence += 1;
    const token = `upload-${this.uploadSequence}`;
    this.uploads.set(token, { key, options, parts: new Map(), open: true });
    return token;
  }

  private session(key: string, upload: MultipartUploadToken): MultipartSession {
    const session = this.uploads.get(upload);
    if (!session || !session.open || session.key !== key) {
      throw new ObjectStorageError("UPLOAD_NOT_FOUND", "Multipart oturumu bulunamadı veya kapatılmış.");
    }
    return session;
  }

  async uploadPart(
    key: string,
    upload: MultipartUploadToken,
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
  ): Promise<UploadedPart> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart parça numarası 1 ile 10000 arasında olmalıdır.");
    }
    const session = this.session(key, upload);
    const bytes = await readAll(value);
    const token = `"part-${partNumber}-${sha256Hex(bytes).slice(0, 16)}"`;
    // S3 anlamsallığı: aynı parça numarası yeniden yüklenirse öncekini değiştirir.
    session.parts.set(partNumber, { bytes, token });
    return { partNumber, token };
  }

  async completeMultipartUpload(
    key: string,
    upload: MultipartUploadToken,
    parts: UploadedPart[],
  ): Promise<ObjectStat> {
    const session = this.session(key, upload);
    if (!parts.length) throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart tamamlama için en az bir parça gerekir.");
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const buffers: Uint8Array[] = [];
    let previous = 0;
    for (const part of ordered) {
      if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10_000
        || part.partNumber === previous || !part.token) {
        throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart parça alındısı geçersiz.");
      }
      previous = part.partNumber;
      const stored = session.parts.get(part.partNumber);
      if (!stored) throw new ObjectStorageError("UPLOAD_NOT_FOUND", "Tamamlama listesindeki parça yüklenmemiş.");
      if (stored.token !== part.token) {
        throw new ObjectStorageError("PART_TOKEN_MISMATCH", "Multipart parça alındısı yüklenen içerikle eşleşmiyor.");
      }
      buffers.push(stored.bytes);
    }
    // R2 kuralı: son parça hariç bütün parçalar aynı boyutta olmalı.
    for (let index = 0; index < buffers.length - 1; index += 1) {
      if (buffers[index].byteLength !== buffers[0].byteLength) {
        throw new ObjectStorageError("PART_SIZE_MISMATCH", "Parça boyutları sağlayıcı kuralına uymuyor.");
      }
    }
    let total = 0;
    for (const buffer of buffers) total += buffer.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const buffer of buffers) {
      merged.set(buffer, offset);
      offset += buffer.byteLength;
    }
    session.open = false;
    this.uploads.delete(upload);
    const version = this.namespace.nextVersion();
    // Bileşik checksum: parça özetlerinin özeti + parça sayısı. İçerik SHA'sı DEĞİL.
    const composite = `${sha256Hex(new TextEncoder().encode(buffers.map((buffer) => sha256Hex(buffer)).join("")))}-${buffers.length}`;
    this.namespace.entries.set(key, {
      bytes: merged,
      contentType: session.options.contentType,
      customMetadata: session.options.customMetadata,
      providerChecksumSha256: composite,
      ...version,
    });
    const stat = this.namespace.stat(key);
    if (!stat) throw new Error("beklenmeyen: tamamlanan nesne bulunamadı");
    return stat;
  }

  async abortMultipartUpload(key: string, upload: MultipartUploadToken): Promise<void> {
    const session = this.session(key, upload);
    session.open = false;
    this.uploads.delete(upload);
  }

  async delete(key: string): Promise<void> {
    this.namespace.entries.delete(key);
  }
}

export class MemoryImmutableVaultWriter implements ImmutableVaultWriter {
  private readonly vault: MemoryNamespace;
  private readonly stagingReader: ObjectReader;

  constructor(vault: MemoryNamespace, stagingReader: ObjectReader) {
    this.vault = vault;
    this.stagingReader = stagingReader;
  }

  async putIfAbsent(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat> {
    if (this.vault.entries.has(key) || this.vault.reservations.has(key)) {
      throw new ObjectStorageError("KEY_ALREADY_EXISTS", "Asıl anahtar zaten dolu; üzerine yazılmaz.");
    }
    this.vault.reservations.add(key);
    try {
      const bytes = await readAll(value);
      const actualSha = sha256Hex(bytes);
      if (options.contentSha256Hex && options.contentSha256Hex.toLowerCase() !== actualSha) {
        throw new ObjectStorageError("PRECONDITION_FAILED", "İçerik SHA-256 değeri sağlayıcı doğrulamasından geçmedi.");
      }
      const version = this.vault.nextVersion();
      this.vault.entries.set(key, {
        bytes,
        contentType: options.contentType,
        customMetadata: options.customMetadata,
        providerChecksumSha256: actualSha,
        ...version,
      });
      const stat = this.vault.stat(key);
      if (!stat) throw new Error("beklenmeyen: yazılan nesne bulunamadı");
      return stat;
    } finally {
      this.vault.reservations.delete(key);
    }
  }

  async promote(sourceKey: string, targetKey: string, options: PutObjectOptions): Promise<ObjectStat> {
    const source = await this.stagingReader.get(sourceKey);
    if (!source) {
      throw new ObjectStorageError("OBJECT_NOT_FOUND", "Terfi kaynağı karantina alanında bulunamadı.");
    }
    return await this.putIfAbsent(targetKey, source.body, options);
  }
}

export class MemoryStorageInventory implements StorageInventory {
  private readonly namespace: MemoryNamespace;

  constructor(namespace: MemoryNamespace) {
    this.namespace = namespace;
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const limit = options?.limit ?? 1000;
    const keys = [...this.namespace.entries.keys()]
      .filter((key) => (options?.prefix ? key.startsWith(options.prefix) : true))
      .sort();
    const start = options?.cursor ? keys.findIndex((key) => key > options.cursor!) : 0;
    const page = start < 0 ? [] : keys.slice(start, start + limit);
    const objects = page.map((key) => {
      const stat = this.namespace.stat(key);
      if (!stat) throw new Error("beklenmeyen: listelenen nesne bulunamadı");
      return { key, ...stat };
    });
    const lastIndex = start < 0 ? keys.length : start + page.length;
    return { objects, cursor: lastIndex < keys.length ? page[page.length - 1] : null };
  }
}

export class MemoryDispositionStorage implements DispositionStorage {
  private readonly namespace: MemoryNamespace;

  constructor(namespace: MemoryNamespace) {
    this.namespace = namespace;
  }

  async delete(key: string): Promise<void> {
    this.namespace.entries.delete(key);
  }
}

/** node:crypto tabanlı akışlı SHA-256; Worker dışındaki sözleşme testleri için. */
export function createNodeStreamingHasher(): StreamingHasher {
  return {
    async sha256(stream: ReadableStream<Uint8Array>): Promise<StreamDigest> {
      const hash = createHash("sha256");
      let byteSize = 0;
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        byteSize += value.byteLength;
      }
      return { sha256Hex: hash.digest("hex"), byteSize };
    },
  };
}

export type MemoryStorageFixture = {
  quarantine: MemoryStagingStorage;
  vaultWriter: MemoryImmutableVaultWriter;
  vaultReader: MemoryObjectReader;
  vaultInventory: MemoryStorageInventory;
  disposition: MemoryDispositionStorage;
  hasher: StreamingHasher;
};

/** ADR-014 topolojisine uygun, ayrı karantina ve asıl ad alanlı takım kurar. */
export function createMemoryStorageFixture(): MemoryStorageFixture {
  const quarantineNamespace = new MemoryNamespace();
  const vaultNamespace = new MemoryNamespace();
  const quarantine = new MemoryStagingStorage(quarantineNamespace);
  return {
    quarantine,
    vaultWriter: new MemoryImmutableVaultWriter(vaultNamespace, quarantine),
    vaultReader: new MemoryObjectReader(vaultNamespace),
    vaultInventory: new MemoryStorageInventory(vaultNamespace),
    disposition: new MemoryDispositionStorage(vaultNamespace),
    hasher: createNodeStreamingHasher(),
  };
}
