/**
 * Kurum içi port P3 testleri için durum tutan sahte S3 sunucusu.
 *
 * MinIO'nun kullandığımız yüzeyini modeller: path-style adresleme, imzalı yük
 * özeti doğrulaması (`x-amz-content-sha256`), `If-None-Match: *` koşullu ilk
 * yazma (PUT ve CompleteMultipartUpload), aralıklı GET, multipart yaşam
 * döngüsü ve v2 listeleme. Sözleşme testi burada koşar; gerçek sağlayıcı
 * davranışı kabul koşusunda (T-01/T-09/T-10) kanıtlanır.
 */

import { createHash } from "node:crypto";

const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

type StoredObject = {
  bytes: Uint8Array;
  contentType: string;
  metadata: Record<string, string>;
  checksumSha256: string | null;
  versionId: string;
  uploadedAt: string;
};

type MultipartUpload = {
  key: string;
  contentType: string;
  metadata: Record<string, string>;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
  aborted: boolean;
};

export type FakeS3Options = {
  bucket?: string;
  /** EntityTooSmall simülasyonu: son parça hariç asgari parça boyutu. */
  minPartBytes?: number;
  /** 5xx simülasyonu: her istek bu durumla döner. */
  failWithStatus?: number;
};

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorResponse(code: string, status: number): Response {
  return new Response(`<Error><Code>${code}</Code></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

export function fakeS3Server(options: FakeS3Options = {}) {
  const bucket = options.bucket ?? "test-bucket";
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, MultipartUpload>();
  let uploadCounter = 0;
  let versionCounter = 0;

  function metadataFrom(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(headers)
      .filter(([name]) => name.startsWith("x-amz-meta-"))
      .map(([name, value]) => [name.slice("x-amz-meta-".length), value]));
  }

  function objectHeaders(object: StoredObject): Record<string, string> {
    return {
      "content-type": object.contentType,
      etag: `"${sha256Hex(object.bytes).slice(0, 32)}"`,
      "x-amz-version-id": object.versionId,
      "last-modified": new Date(object.uploadedAt).toUTCString(),
      ...(object.checksumSha256
        ? { "x-amz-checksum-sha256": Buffer.from(object.checksumSha256, "hex").toString("base64") }
        : {}),
      ...Object.fromEntries(Object.entries(object.metadata)
        .map(([name, value]) => [`x-amz-meta-${name}`, value])),
    };
  }

  async function fetcher(urlValue: string | URL, init: RequestInit = {}): Promise<Response> {
    if (options.failWithStatus) return errorResponse("InternalError", options.failWithStatus);
    const url = new URL(urlValue);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const requestBucket = segments.shift();
    const key = segments.join("/");
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries(
      (init.headers ?? {}) as Record<string, string>,
    ).map(([name, value]) => [name.toLowerCase(), value]));
    if (requestBucket !== bucket) return errorResponse("NoSuchBucket", 404);

    const bodyBytes = init.body
      ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      : new Uint8Array();
    // İmzalı yük özeti sunucuda doğrulanır; uyuşmazlık yazmayı reddeder.
    const declaredHash = headers["x-amz-content-sha256"];
    if (["PUT", "POST"].includes(method) && declaredHash && declaredHash !== "UNSIGNED-PAYLOAD"
      && sha256Hex(bodyBytes) !== declaredHash) {
      return errorResponse("XAmzContentSHA256Mismatch", 400);
    }

    // Multipart yaşam döngüsü.
    if (method === "POST" && url.searchParams.has("uploads")) {
      const uploadId = `upload-${++uploadCounter}`;
      uploads.set(uploadId, {
        key,
        contentType: headers["content-type"] ?? "application/octet-stream",
        metadata: metadataFrom(headers),
        parts: new Map(),
        aborted: false,
      });
      return new Response(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`, { status: 200 });
    }
    if (method === "PUT" && url.searchParams.has("uploadId")) {
      const upload = uploads.get(url.searchParams.get("uploadId") ?? "");
      if (!upload || upload.aborted || upload.key !== key) return errorResponse("NoSuchUpload", 404);
      const partNumber = Number(url.searchParams.get("partNumber"));
      const etag = sha256Hex(bodyBytes).slice(0, 32);
      upload.parts.set(partNumber, { bytes: bodyBytes, etag });
      return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
    }
    if (method === "POST" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const upload = uploads.get(uploadId);
      if (!upload || upload.aborted || upload.key !== key) return errorResponse("NoSuchUpload", 404);
      if (headers["if-none-match"] === "*" && objects.has(key)) {
        return errorResponse("PreconditionFailed", 412);
      }
      const text = new TextDecoder().decode(bodyBytes);
      const requested = [...text.matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>"?([^<"]+)"?<\/ETag><\/Part>/g)]
        .map(([, partNumber, etag]) => ({ partNumber: Number(partNumber), etag }));
      if (!requested.length) return errorResponse("MalformedXML", 400);
      const merged: Uint8Array[] = [];
      for (const [index, part] of requested.entries()) {
        const stored = upload.parts.get(part.partNumber);
        if (!stored || stored.etag !== part.etag) return errorResponse("InvalidPart", 400);
        if (options.minPartBytes && index < requested.length - 1
          && stored.bytes.byteLength < options.minPartBytes) {
          return errorResponse("EntityTooSmall", 400);
        }
        merged.push(stored.bytes);
      }
      const bytes = new Uint8Array(merged.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of merged) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      objects.set(key, {
        bytes,
        contentType: upload.contentType,
        metadata: upload.metadata,
        checksumSha256: null,
        versionId: `v${++versionCounter}`,
        uploadedAt: new Date().toISOString(),
      });
      uploads.delete(uploadId);
      return new Response(`<CompleteMultipartUploadResult><ETag>"${sha256Hex(bytes).slice(0, 32)}"</ETag></CompleteMultipartUploadResult>`, { status: 200 });
    }
    if (method === "DELETE" && url.searchParams.has("uploadId")) {
      const upload = uploads.get(url.searchParams.get("uploadId") ?? "");
      if (!upload || upload.aborted) return errorResponse("NoSuchUpload", 404);
      upload.aborted = true;
      return new Response(null, { status: 204 });
    }

    // Listeleme (v2).
    if (method === "GET" && !key && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const maxKeys = Number(url.searchParams.get("max-keys") ?? 1000);
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const matched = [...objects.entries()]
        .filter(([entryKey]) => entryKey.startsWith(prefix))
        .sort(([left], [right]) => (left < right ? -1 : 1));
      const page = matched.slice(start, start + maxKeys);
      const truncated = start + maxKeys < matched.length;
      const contents = page.map(([entryKey, object]) => `<Contents><Key>${xmlEscape(entryKey)}</Key>`
        + `<LastModified>${object.uploadedAt}</LastModified>`
        + `<ETag>"${sha256Hex(object.bytes).slice(0, 32)}"</ETag>`
        + `<Size>${object.bytes.byteLength}</Size></Contents>`).join("");
      return new Response(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>`
        + (truncated ? `<NextContinuationToken>${start + maxKeys}</NextContinuationToken>` : "")
        + `${contents}</ListBucketResult>`, { status: 200 });
    }

    const current = objects.get(key);
    if (method === "HEAD") {
      if (!current) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: { ...objectHeaders(current), "content-length": String(current.bytes.byteLength) },
      });
    }
    if (method === "GET") {
      if (!current) return errorResponse("NoSuchKey", 404);
      const range = /^bytes=(\d+)-(\d*)$/.exec(headers.range ?? "");
      if (range) {
        const offset = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), current.bytes.byteLength - 1)
          : current.bytes.byteLength - 1;
        const slice = current.bytes.subarray(offset, end + 1);
        return new Response(slice as unknown as BodyInit, {
          status: 206,
          headers: {
            ...objectHeaders(current),
            "content-length": String(slice.byteLength),
            "content-range": `bytes ${offset}-${end}/${current.bytes.byteLength}`,
          },
        });
      }
      return new Response(current.bytes as unknown as BodyInit, {
        status: 200,
        headers: { ...objectHeaders(current), "content-length": String(current.bytes.byteLength) },
      });
    }
    if (method === "PUT") {
      if (headers["if-none-match"] === "*" && current) return errorResponse("PreconditionFailed", 412);
      objects.set(key, {
        bytes: bodyBytes,
        contentType: headers["content-type"] ?? "application/octet-stream",
        metadata: metadataFrom(headers),
        checksumSha256: headers["x-amz-checksum-sha256"]
          ? Buffer.from(headers["x-amz-checksum-sha256"], "base64").toString("hex")
          : null,
        versionId: `v${++versionCounter}`,
        uploadedAt: new Date().toISOString(),
      });
      const stored = objects.get(key) as StoredObject;
      return new Response(null, { status: 200, headers: objectHeaders(stored) });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return errorResponse("MethodNotAllowed", 405);
  }

  return { fetcher: fetcher as typeof fetch, objects, uploads, bucket };
}
