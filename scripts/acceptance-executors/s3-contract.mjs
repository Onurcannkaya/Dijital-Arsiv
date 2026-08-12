/**
 * Minimal AWS Signature V4 S3 istemcisi.
 *
 * Kabul y?r?t?c?s? d???nda kullan?lmaz. Kimlik bilgileri yaln?z bellekte kal?r;
 * d?n?? de?eri g?vde/ba?l?k yerine maskeli durum ve kararl? sa?lay?c? kodu ta??r.
 */
import { createHash, createHmac } from "node:crypto";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const SAFE_PROVIDER_CODE = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(parameters = {}) {
  return Object.entries(parameters)
    .flatMap(([name, value]) => Array.isArray(value)
      ? value.map((entry) => [name, entry]) : [[name, value]])
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [awsEncode(name), awsEncode(String(value))])
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName < rightName ? -1 : leftName > rightName ? 1
        : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
    ))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function xmlValue(bytes, tag) {
  const text = new TextDecoder().decode(bytes);
  const match = text.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return match?.[1] ?? null;
}

function xmlBody(root, values) {
  const children = Object.entries(values)
    .map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return Buffer.from(
    `<${root} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${children}</${root}>`,
  );
}

function canonicalPath(endpoint, bucket, key) {
  const prefix = endpoint.pathname.replace(/\/$/, "");
  return `${prefix}/${awsEncode(bucket)}/${String(key).split("/").map(awsEncode).join("/")}`;
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function providerCode(text, status) {
  const match = typeof text === "string" ? text.match(/<Code>([^<]{1,128})<\/Code>/) : null;
  return match && SAFE_PROVIDER_CODE.test(match[1]) ? match[1]
    : status === 403 ? "AccessDenied"
      : status === 404 ? "NoSuchKey"
        : status === 409 ? "Conflict"
          : status === 412 ? "PreconditionFailed"
            : `HTTP_${status}`;
}

export function isProviderDenied(result) {
  return result.status === 401 || result.status === 403
    || ["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"]
      .includes(result.code);
}

export function isConditionalConflict(result) {
  return result.status === 409 || result.status === 412
    || ["Conflict", "ConditionalRequestConflict", "PreconditionFailed"]
      .includes(result.code);
}

export function createS3Client({
  endpoint, bucket, region = "auto", credentials, signal, fetcher = fetch,
  now = () => new Date(),
}) {
  const base = new URL(endpoint);
  if (base.protocol !== "https:" || !bucket || bucket.includes("/")) {
    throw new Error("S3 kabul istemcisi HTTPS u? noktas? ve g?venli kova ad? gerektirir.");
  }
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("S3 kabul istemcisi ayr? IAM kimlik bilgileri gerektirir.");
  }

  async function request(method, key, {
    bytes, ifNoneMatch, query, headers = {},
  } = {}) {
    const payload = bytes === undefined ? new Uint8Array() : Uint8Array.from(bytes);
    const payloadHash = method === "GET" || method === "HEAD" || method === "DELETE"
      ? EMPTY_SHA256 : sha256(payload);
    const instant = now();
    const amzDate = amzTimestamp(instant);
    const dateStamp = amzDate.slice(0, 8);
    const pathname = canonicalPath(base, bucket, key);
    const url = new URL(base);
    url.pathname = pathname;
    const queryString = canonicalQuery(query);
    url.search = queryString ? `?${queryString}` : "";

    const signed = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (credentials.sessionToken) signed["x-amz-security-token"] = credentials.sessionToken;
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) signed[name.toLowerCase()] = String(value);
    }
    if (ifNoneMatch) signed["if-none-match"] = ifNoneMatch;
    const signedHeaderNames = Object.keys(signed).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${String(signed[name]).trim().replace(/\s+/g, " ")}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      method, pathname, queryString, canonicalHeaders, signedHeaders, payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest),
    ].join("\n");
    const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const authorization = "AWS4-HMAC-SHA256 "
      + `Credential=${credentials.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetcher(url, {
      method,
      headers: { ...signed, authorization },
      body: ["PUT", "POST"].includes(method) ? payload : undefined,
      signal,
    });
    const responseBytes = method === "GET" && response.ok
      ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array();
    const errorText = response.ok ? "" : await response.text();
    const metadata = response.ok ? Object.fromEntries([...response.headers.entries()]
      .filter(([name]) => name.startsWith("x-amz-meta-"))
      .map(([name, value]) => [name.slice("x-amz-meta-".length), value]))
      : {};
    return {
      ok: response.ok,
      status: response.status,
      code: response.ok ? "OK" : providerCode(errorText, response.status),
      bytes: responseBytes,
      byteSize: response.ok
        ? Number(response.headers.get("content-length") ?? responseBytes.byteLength)
        : null,
      etag: response.ok ? response.headers.get("etag") : null,
      versionId: response.ok ? response.headers.get("x-amz-version-id") : null,
      lockMode: response.ok ? response.headers.get("x-amz-object-lock-mode") : null,
      retainUntilDate: response.ok ? response.headers.get("x-amz-object-lock-retain-until-date") : null,
      legalHold: response.ok ? response.headers.get("x-amz-object-lock-legal-hold") : null,
      metadata,
    };
  }

  function xmlPut(key, query, root, values) {
    const bytes = xmlBody(root, values);
    return request("PUT", key, {
      bytes,
      query,
      headers: {
        "content-type": "application/xml",
        "content-md5": createHash("md5").update(bytes).digest("base64"),
      },
    });
  }


  return {
    putIfAbsent: (key, bytes) => request("PUT", key, { bytes, ifNoneMatch: "*" }),
    get: (key) => request("GET", key),
    head: (key) => request("HEAD", key),
    delete: (key) => request("DELETE", key),
    deleteVersion: (key, versionId) => request("DELETE", key, { query: { versionId } }),
    put: (key, bytes) => request("PUT", key, { bytes }),
    putLocked: (key, bytes, { mode, retainUntilDate, legalHold } = {}) => request("PUT", key, {
      bytes,
      headers: {
        "content-md5": createHash("md5").update(bytes).digest("base64"),
        "x-amz-object-lock-mode": mode,
        "x-amz-object-lock-retain-until-date": retainUntilDate,
        "x-amz-object-lock-legal-hold": legalHold,
      },
    }),
    getBucketVersioning: async () => {
      const result = await request("GET", "", { query: { versioning: "" } });
      return { ...result, versioningStatus: result.ok ? xmlValue(result.bytes, "Status") : null };
    },
    getObjectLockConfiguration: async () => {
      const result = await request("GET", "", { query: { "object-lock": "" } });
      return { ...result, objectLockEnabled: result.ok ? xmlValue(result.bytes, "ObjectLockEnabled") : null };
    },
    getRetention: async (key, versionId) => {
      const result = await request("GET", key, { query: { retention: "", versionId } });
      return {
        ...result,
        retentionMode: result.ok ? xmlValue(result.bytes, "Mode") : null,
        retentionUntilDate: result.ok ? xmlValue(result.bytes, "RetainUntilDate") : null,
      };
    },
    putRetention: (key, versionId, { mode, retainUntilDate }) => xmlPut(
      key, { retention: "", versionId }, "Retention", { Mode: mode, RetainUntilDate: retainUntilDate },
    ),
    getLegalHold: async (key, versionId) => {
      const result = await request("GET", key, { query: { "legal-hold": "", versionId } });
      return { ...result, legalHoldStatus: result.ok ? xmlValue(result.bytes, "Status") : null };
    },
    putLegalHold: (key, versionId, status) => xmlPut(
      key, { "legal-hold": "", versionId }, "LegalHold", { Status: status },
    ),
  };
}

export function maskedProviderResult(result) {
  return {
    ok: result.ok,
    status: result.status,
    code: result.code,
    byteSize: result.byteSize,
    hasEtag: Boolean(result.etag),
    hasVersionId: Boolean(result.versionId),
    lockMode: result.lockMode ?? result.retentionMode ?? null,
    hasRetentionDate: Boolean(result.retainUntilDate ?? result.retentionUntilDate),
    legalHoldStatus: result.legalHoldStatus ?? result.legalHold ?? null,
    versioningStatus: result.versioningStatus ?? null,
    objectLockEnabled: result.objectLockEnabled ?? null,
  };
}
