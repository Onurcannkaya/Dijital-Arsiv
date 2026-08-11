/**
 * Kurum içi port P3 — S3 uyumlu (MinIO) nesne depolama adaptörleri.
 *
 * `lib/object-storage.ts` rol sözleşmelerinin AWS Signature V4 üzerinden,
 * SDK'sız uygulamasıdır; hedef kurum içi MinIO'dur ama yalnız standart S3
 * API'si kullanılır. R2 adaptörüyle (lib/r2-object-storage.ts) davranış
 * eşliği esastır:
 *
 * - Koşullu ilk yazma: tek parça PUT'ta `If-None-Match: *`; iç multipart'ta
 *   koşul `CompleteMultipartUpload` isteğine taşınır. Her ikisi de 412'yi
 *   `KEY_ALREADY_EXISTS` koduna eşler. Gerçek sağlayıcı davranışı kabul
 *   koşusunda T-01 ile kanıtlanır; hedef MinIO sürümünün koşullu yazma
 *   desteği kurulumda doğrulanmalıdır (KURUM_ICI_PORT_KAPSAMI.md riskleri).
 * - Akış gövdeleri: S3 PUT `Content-Length` ister. Uzunluğu bilinmeyen akış,
 *   bellekte yalnız TEK iç parça tutularak (varsayılan 16 MiB) gerekirse iç
 *   multipart'a dönüştürülür; 2 GiB'lık terfi kopyası K-6 bellek disiplinini
 *   bozmaz.
 * - `contentSha256Hex` verildiğinde tek parça yazmada imzalı yük özeti olarak
 *   gönderilir; sağlayıcı uyuşmazlığı reddeder ve adaptör bunu
 *   `PRECONDITION_FAILED` koduna eşler (R2 davranış eşi).
 *
 * Bu dosya Workers paketine girmez; yalnız Node önyüklemesi (P4) ve testler
 * içe aktarır.
 */

import { createHash, createHmac } from "node:crypto";

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

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const DEFAULT_INTERNAL_PART_BYTES = 16 * 1024 * 1024;

export type NodeS3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type NodeS3Config = {
  /** HTTPS S3 ucu (path-style istek atılır). */
  endpoint: string;
  bucket: string;
  region?: string;
  credentials: NodeS3Credentials;
  /** Test enjeksiyonu; varsayılan global fetch. */
  fetcher?: typeof fetch;
  /** Akış gövdelerinde iç multipart parça boyutu (test için küçültülebilir). */
  internalPartBytes?: number;
  /**
   * Yalnız izole konteyner ağı içindeki MinIO için düz HTTP'ye açık izin
   * (ör. http://minio:9000). Varsayılan kapalıdır; ağ dışına çıkan uçlarda
   * kullanılmamalıdır.
   */
  allowHttp?: boolean;
  now?: () => Date;
};

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#3[49];/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlValue(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? xmlUnescape(match[1]) : null;
}

function stripQuotes(etag: string | null): string | null {
  return etag ? etag.replace(/^"|"$/g, "") : null;
}

function base64ToHex(value: string | null): string | null {
  if (!value) return null;
  try {
    return Buffer.from(value, "base64").toString("hex");
  } catch {
    return null;
  }
}

async function toBytes(value: Exclude<ObjectStorageValue, ReadableStream<Uint8Array>>): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Gövdeyi en fazla `partBytes` boyutlu parçalara böler; bellekte aynı anda
 * yalnız tek parça tutulur. Akış olmayan değerler tek parça olarak döner.
 */
async function* partChunks(
  value: ObjectStorageValue,
  partBytes: number,
): AsyncGenerator<Uint8Array> {
  if (!(value instanceof ReadableStream)) {
    yield await toBytes(value);
    return;
  }
  const reader = value.getReader();
  let pending: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(partBytes - size, chunk.byteLength - offset);
      pending.push(chunk.subarray(offset, offset + take));
      size += take;
      offset += take;
      if (size === partBytes) {
        yield concatChunks(pending, size);
        pending = [];
        size = 0;
      }
    }
  }
  yield concatChunks(pending, size);
}

type S3Response = {
  status: number;
  ok: boolean;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
};

class S3Http {
  private readonly base: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly credentials: NodeS3Credentials;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(config: NodeS3Config) {
    this.base = new URL(config.endpoint);
    const protocolAllowed = this.base.protocol === "https:"
      || (this.base.protocol === "http:" && config.allowHttp === true);
    if (!protocolAllowed || !config.bucket || config.bucket.includes("/")) {
      throw new ObjectStorageError("INVALID_ARGUMENT",
        "S3 adaptörü HTTPS uç noktası (ya da açıkça izin verilmiş konteyner içi HTTP) ve güvenli kova adı gerektirir.");
    }
    if (!config.credentials?.accessKeyId || !config.credentials?.secretAccessKey) {
      throw new ObjectStorageError("INVALID_ARGUMENT", "S3 adaptörü erişim kimliği gerektirir.");
    }
    this.bucket = config.bucket;
    this.region = config.region ?? "auto";
    this.credentials = config.credentials;
    this.fetcher = config.fetcher ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  async request(method: string, key: string, input: {
    query?: Record<string, string>;
    headers?: Record<string, string | undefined>;
    body?: Uint8Array | null;
    payloadHashHex?: string;
  } = {}): Promise<S3Response> {
    const payload = input.body ?? new Uint8Array();
    const payloadHash = input.payloadHashHex
      ?? (payload.byteLength === 0 ? EMPTY_SHA256 : sha256Hex(payload));
    const instant = this.now();
    const amzDate = instant.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const prefix = this.base.pathname.replace(/\/$/, "");
    const pathname = `${prefix}/${awsEncode(this.bucket)}/${key.split("/").map(awsEncode).join("/")}`
      .replace(/\/$/, key === "" ? "/" : "");
    const url = new URL(this.base);
    url.pathname = pathname;
    const queryString = Object.entries(input.query ?? {})
      .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    url.search = queryString ? `?${queryString}` : "";

    const signed: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (this.credentials.sessionToken) signed["x-amz-security-token"] = this.credentials.sessionToken;
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (value !== undefined && value !== null) signed[name.toLowerCase()] = String(value);
    }
    const signedNames = Object.keys(signed).sort();
    const canonicalHeaders = signedNames
      .map((name) => `${name}:${signed[name].trim().replace(/\s+/g, " ")}\n`).join("");
    const canonicalRequest = [
      method, pathname, queryString, canonicalHeaders, signedNames.join(";"), payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(
      `AWS4${this.credentials.secretAccessKey}`, dateStamp), this.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = "AWS4-HMAC-SHA256 "
      + `Credential=${this.credentials.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: { ...signed, authorization },
        // Workers tip kümesi Uint8Array'i BodyInit saymıyor; çalışma zamanı destekler.
        body: (["PUT", "POST"].includes(method) && input.body ? payload : undefined) as BodyInit | undefined,
      });
    } catch (cause) {
      throw new ObjectStorageError("PROVIDER_UNAVAILABLE", "Depolama sağlayıcısına ulaşılamadı.", { cause });
    }
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: response.body as ReadableStream<Uint8Array> | null,
      text: () => response.text(),
    };
  }
}

async function providerErrorCode(response: S3Response): Promise<string | null> {
  try {
    const text = await response.text();
    const match = text.match(/<Code>([A-Za-z0-9._-]{1,128})<\/Code>/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function mapProviderError(operation: string, response: S3Response): Promise<ObjectStorageError> {
  const code = await providerErrorCode(response);
  if (response.status === 412 || code === "PreconditionFailed") {
    return new ObjectStorageError("KEY_ALREADY_EXISTS", "Asıl anahtar zaten dolu; üzerine yazılmaz.");
  }
  if (code === "XAmzContentSHA256Mismatch" || code === "BadDigest") {
    return new ObjectStorageError("PRECONDITION_FAILED", "İçerik SHA-256 değeri sağlayıcı doğrulamasından geçmedi.");
  }
  if (code === "NoSuchUpload") {
    return new ObjectStorageError("UPLOAD_NOT_FOUND", "Multipart oturumu bulunamadı veya kapatılmış.");
  }
  if (code === "EntityTooSmall") {
    return new ObjectStorageError("PART_SIZE_MISMATCH", "Parça boyutları sağlayıcı kuralına uymuyor.");
  }
  if (code === "InvalidPart" || code === "InvalidPartOrder") {
    return new ObjectStorageError("PART_TOKEN_MISMATCH", "Multipart parça alındısı yüklenen içerikle eşleşmiyor.");
  }
  return new ObjectStorageError("PROVIDER_UNAVAILABLE",
    `Depolama sağlayıcısı ${operation} işlemini tamamlayamadı (HTTP ${response.status}).`);
}

function customMetadataFrom(headers: Headers): Record<string, string> | undefined {
  const entries: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    if (name.startsWith("x-amz-meta-")) entries.push([name.slice("x-amz-meta-".length), value]);
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function statFromHeaders(headers: Headers, size: number): ObjectStat {
  const lastModified = headers.get("last-modified");
  return {
    size,
    contentType: headers.get("content-type"),
    etag: stripQuotes(headers.get("etag")),
    providerVersionId: headers.get("x-amz-version-id"),
    providerChecksumSha256: base64ToHex(headers.get("x-amz-checksum-sha256")),
    uploadedAt: lastModified ? new Date(lastModified).toISOString() : null,
    customMetadata: customMetadataFrom(headers),
  };
}

function metadataHeaders(options: PutObjectOptions): Record<string, string> {
  const headers: Record<string, string> = { "content-type": options.contentType };
  for (const [name, value] of Object.entries(options.customMetadata ?? {})) {
    headers[`x-amz-meta-${name.toLowerCase()}`] = value;
  }
  return headers;
}

function rangeHeader(range: ByteRange): string {
  const end = range.length !== undefined ? range.offset + range.length - 1 : "";
  return `bytes=${range.offset}-${end}`;
}

export class NodeS3ObjectReader implements ObjectReader {
  protected readonly http: S3Http;

  constructor(config: NodeS3Config) {
    this.http = new S3Http(config);
  }

  async get(key: string, options?: { range?: ByteRange }): Promise<ObjectBody | null> {
    const response = await this.http.request("GET", key, {
      headers: options?.range ? { range: rangeHeader(options.range) } : undefined,
    });
    if (response.status === 404) return null;
    if (!response.ok || !response.body) throw await mapProviderError("okuma", response);
    const bodySize = Number(response.headers.get("content-length") ?? 0);
    if (response.status === 206) {
      const contentRange = /bytes (\d+)-(\d+)\/(\d+)/.exec(response.headers.get("content-range") ?? "");
      const offset = contentRange ? Number(contentRange[1]) : options?.range?.offset ?? 0;
      const total = contentRange ? Number(contentRange[3]) : bodySize;
      return {
        ...statFromHeaders(response.headers, total),
        body: response.body,
        bodySize,
        range: { offset, length: bodySize },
      };
    }
    return {
      ...statFromHeaders(response.headers, bodySize),
      body: response.body,
      bodySize,
      range: null,
    };
  }

  async head(key: string): Promise<ObjectStat | null> {
    const response = await this.http.request("HEAD", key);
    if (response.status === 404) return null;
    if (!response.ok) throw await mapProviderError("başlık okuma", response);
    return statFromHeaders(response.headers, Number(response.headers.get("content-length") ?? 0));
  }
}

/** Tek parça ya da iç multipart yazma; koşul verilirse ilk-yazma garantisi taşır. */
class NodeS3Writer extends NodeS3ObjectReader {
  protected readonly internalPartBytes: number;

  constructor(config: NodeS3Config) {
    super(config);
    this.internalPartBytes = Math.max(5 * 1024 * 1024, config.internalPartBytes ?? DEFAULT_INTERNAL_PART_BYTES);
  }

  protected async write(
    key: string,
    value: ObjectStorageValue,
    options: PutObjectOptions,
    condition: { ifNoneMatch?: boolean },
  ): Promise<ObjectStat> {
    const iterator = partChunks(value, this.internalPartBytes);
    const first = await iterator.next();
    const firstBytes = first.value ?? new Uint8Array();
    const second = await iterator.next();
    if (second.done) {
      return await this.writeSingle(key, firstBytes, options, condition);
    }
    return await this.writeMultipart(key, [firstBytes, second.value], iterator, options, condition);
  }

  private async writeSingle(
    key: string,
    bytes: Uint8Array,
    options: PutObjectOptions,
    condition: { ifNoneMatch?: boolean },
  ): Promise<ObjectStat> {
    const response = await this.http.request("PUT", key, {
      body: bytes,
      // İmzalı yük özeti: verilmişse sağlayıcı içerikle karşılaştırıp reddeder.
      payloadHashHex: options.contentSha256Hex,
      // Content-Length başlığını fetch uygulaması gövdeden koyar; elle
      // eklemek undici doğrulamasıyla çakışabilir.
      headers: {
        ...metadataHeaders(options),
        ...(options.contentSha256Hex
          ? { "x-amz-checksum-sha256": Buffer.from(options.contentSha256Hex, "hex").toString("base64") }
          : {}),
        ...(condition.ifNoneMatch ? { "if-none-match": "*" } : {}),
      },
    });
    if (!response.ok) throw await mapProviderError("yazma", response);
    return {
      ...statFromHeaders(response.headers, bytes.byteLength),
      contentType: options.contentType,
      customMetadata: options.customMetadata,
      providerChecksumSha256: options.contentSha256Hex ?? null,
    };
  }

  private async writeMultipart(
    key: string,
    initialParts: Uint8Array[],
    iterator: AsyncGenerator<Uint8Array>,
    options: PutObjectOptions,
    condition: { ifNoneMatch?: boolean },
  ): Promise<ObjectStat> {
    const upload = await this.createMultipart(key, options);
    const parts: UploadedPart[] = [];
    let total = 0;
    try {
      const uploadOne = async (bytes: Uint8Array) => {
        const part = await this.uploadMultipartPart(key, upload, parts.length + 1, bytes);
        parts.push(part);
        total += bytes.byteLength;
      };
      for (const bytes of initialParts) await uploadOne(bytes);
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        await uploadOne(next.value);
      }
      const stat = await this.completeMultipart(key, upload, parts, condition);
      return { ...stat, size: total, contentType: options.contentType, customMetadata: options.customMetadata };
    } catch (error) {
      try {
        await this.abortMultipart(key, upload);
      } catch {
        /* yarım yükleme yaşam döngüsü kuralıyla temizlenir */
      }
      throw error;
    }
  }

  protected async createMultipart(key: string, options: PutObjectOptions): Promise<MultipartUploadToken> {
    const response = await this.http.request("POST", key, {
      query: { uploads: "" },
      headers: metadataHeaders(options),
    });
    if (!response.ok) throw await mapProviderError("multipart başlatma", response);
    const uploadId = xmlValue(await response.text(), "UploadId");
    if (!uploadId) {
      throw new ObjectStorageError("PROVIDER_UNAVAILABLE", "Sağlayıcı multipart oturum kimliği döndürmedi.");
    }
    return uploadId;
  }

  protected async uploadMultipartPart(
    key: string,
    upload: MultipartUploadToken,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<UploadedPart> {
    const response = await this.http.request("PUT", key, {
      query: { partNumber: String(partNumber), uploadId: upload },
      body: bytes,
    });
    if (!response.ok) throw await mapProviderError("parça yükleme", response);
    const token = stripQuotes(response.headers.get("etag"));
    if (!token) throw new ObjectStorageError("PROVIDER_UNAVAILABLE", "Sağlayıcı parça alındısı döndürmedi.");
    return { partNumber, token };
  }

  protected async completeMultipart(
    key: string,
    upload: MultipartUploadToken,
    parts: UploadedPart[],
    condition: { ifNoneMatch?: boolean } = {},
  ): Promise<ObjectStat> {
    const body = new TextEncoder().encode(
      "<CompleteMultipartUpload>"
      + parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.token}"</ETag></Part>`).join("")
      + "</CompleteMultipartUpload>",
    );
    const response = await this.http.request("POST", key, {
      query: { uploadId: upload },
      body,
      headers: {
        "content-type": "application/xml",
        ...(condition.ifNoneMatch ? { "if-none-match": "*" } : {}),
      },
    });
    if (!response.ok) throw await mapProviderError("multipart tamamlama", response);
    // S3 tamamlamada 200 gövdesi hata da taşıyabilir; ETag yoksa hata say.
    const text = await response.text();
    if (/<Error>/.test(text)) {
      throw new ObjectStorageError("PROVIDER_UNAVAILABLE", "Sağlayıcı multipart tamamlamayı reddetti.");
    }
    const head = await this.head(key);
    if (!head) {
      throw new ObjectStorageError("PROVIDER_UNAVAILABLE", "Tamamlanan multipart nesnesi doğrulanamadı.");
    }
    return head;
  }

  protected async abortMultipart(key: string, upload: MultipartUploadToken): Promise<void> {
    const response = await this.http.request("DELETE", key, { query: { uploadId: upload } });
    if (!response.ok && response.status !== 404) {
      throw await mapProviderError("multipart iptali", response);
    }
  }
}

export class NodeS3StagingStorage extends NodeS3Writer implements StagingStorage {
  async put(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat> {
    return await this.write(key, value, options, {});
  }

  async createMultipartUpload(key: string, options: PutObjectOptions): Promise<MultipartUploadToken> {
    return await this.createMultipart(key, options);
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
    // Parça sözleşmesi zaten sınırlı boyutludur (ADR-014: 16 MiB); tamponlanır.
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of partChunks(value, Number.MAX_SAFE_INTEGER)) {
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    return await this.uploadMultipartPart(key, upload, partNumber, concatChunks(chunks, size));
  }

  async completeMultipartUpload(
    key: string,
    upload: MultipartUploadToken,
    parts: UploadedPart[],
  ): Promise<ObjectStat> {
    if (!parts.length) {
      throw new ObjectStorageError("INVALID_ARGUMENT", "Multipart tamamlama için en az bir parça gerekir.");
    }
    const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber);
    return await this.completeMultipart(key, upload, ordered);
  }

  async abortMultipartUpload(key: string, upload: MultipartUploadToken): Promise<void> {
    await this.abortMultipart(key, upload);
  }

  async delete(key: string): Promise<void> {
    const response = await this.http.request("DELETE", key);
    if (!response.ok && response.status !== 404) {
      throw await mapProviderError("silme", response);
    }
  }
}

export class NodeS3ImmutableVaultWriter extends NodeS3Writer implements ImmutableVaultWriter {
  private readonly stagingReader: ObjectReader;

  /**
   * @param stagingReader `promote` kaynağını akışla okuyan salt-okunur rol;
   * ADR-014 gereği kaynak ve hedef ayrı kovalardır.
   */
  constructor(config: NodeS3Config, stagingReader: ObjectReader) {
    super(config);
    this.stagingReader = stagingReader;
  }

  async putIfAbsent(key: string, value: ObjectStorageValue, options: PutObjectOptions): Promise<ObjectStat> {
    return await this.write(key, value, options, { ifNoneMatch: true });
  }

  async promote(sourceKey: string, targetKey: string, options: PutObjectOptions): Promise<ObjectStat> {
    const source = await this.stagingReader.get(sourceKey);
    if (!source) {
      throw new ObjectStorageError("OBJECT_NOT_FOUND", "Terfi kaynağı karantina alanında bulunamadı.");
    }
    return await this.putIfAbsent(targetKey, source.body, options);
  }
}

export class NodeS3StorageInventory implements StorageInventory {
  private readonly http: S3Http;

  constructor(config: NodeS3Config) {
    this.http = new S3Http(config);
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const query: Record<string, string> = { "list-type": "2" };
    if (options?.prefix) query.prefix = options.prefix;
    if (options?.cursor) query["continuation-token"] = options.cursor;
    if (options?.limit) query["max-keys"] = String(options.limit);
    const response = await this.http.request("GET", "", { query });
    if (!response.ok) throw await mapProviderError("listeleme", response);
    const text = await response.text();
    const objects = [...text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, entry]) => ({
      key: xmlValue(entry, "Key") ?? "",
      size: Number(xmlValue(entry, "Size") ?? 0),
      contentType: null,
      etag: stripQuotes(xmlValue(entry, "ETag")),
      providerVersionId: null,
      providerChecksumSha256: null,
      uploadedAt: xmlValue(entry, "LastModified"),
    }));
    const truncated = xmlValue(text, "IsTruncated") === "true";
    return {
      objects,
      cursor: truncated ? xmlValue(text, "NextContinuationToken") : null,
    };
  }
}

export class NodeS3DispositionStorage implements DispositionStorage {
  private readonly http: S3Http;

  constructor(config: NodeS3Config) {
    this.http = new S3Http(config);
  }

  async delete(key: string): Promise<void> {
    const response = await this.http.request("DELETE", key);
    if (!response.ok && response.status !== 404) {
      throw await mapProviderError("tasfiye silmesi", response);
    }
  }
}
