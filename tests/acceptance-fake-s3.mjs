import { createHash } from "node:crypto";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function testCredentials(accessKeyId) {
  return { accessKeyId, secretAccessKey: `secret-${accessKeyId}-0123456789` };
}

function xmlError(code, status) {
  return new Response(`<Error><Code>${code}</Code></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });
}

export function fakeS3({ staging, originalBucket = "original-test", quarantineBucket = "quarantine-test" } = {}) {
  const store = new Map();

  function payloadFor(bucket, key) {
    const stored = store.get(`${bucket}/${key}`);
    if (stored) return stored;
    const match = key.match(/^(?:original|quarantine)\/(sess-[0-9]+)$/);
    const session = match ? staging?.sessions.get(match[1]) : null;
    return session?.payload ? Uint8Array.from(session.payload) : null;
  }

  async function fetcher(urlValue, init = {}) {
    const url = new URL(urlValue);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const bucket = parts.shift();
    const key = parts.join("/");
    const authorization = String(init.headers?.authorization ?? init.headers?.Authorization ?? "");
    const accessKey = authorization.match(/Credential=([^/]+)\//)?.[1] ?? "";
    const method = init.method ?? "GET";
    const objectClass = bucket === originalBucket ? "original"
      : bucket === quarantineBucket ? "quarantine" : "unknown";
    const canRead = accessKey === "promotion"
      || (accessKey === "ocr" && objectClass === "original")
      || (accessKey === "scanner" && objectClass === "quarantine");
    const canWrite = accessKey === "promotion" && objectClass === "original";

    if (["GET", "HEAD"].includes(method)) {
      if (!canRead) return xmlError("AccessDenied", 403);
      const payload = payloadFor(bucket, key);
      if (!payload) return xmlError("NoSuchKey", 404);
      return new Response(method === "HEAD" ? null : payload, {
        status: 200,
        headers: {
          "content-length": String(payload.byteLength),
          etag: `"${sha256(payload).slice(0, 32)}"`,
          "x-amz-version-id": "version-1",
          "x-amz-meta-sha256": sha256(payload),
        },
      });
    }
    if (method === "PUT") {
      if (!canWrite) return xmlError("AccessDenied", 403);
      const storageKey = `${bucket}/${key}`;
      if (init.headers?.["if-none-match"] === "*" && payloadFor(bucket, key)) {
        return xmlError("PreconditionFailed", 412);
      }
      const payload = new Uint8Array(await new Response(init.body).arrayBuffer());
      store.set(storageKey, payload);
      return new Response(null, {
        status: 200,
        headers: { etag: `"${sha256(payload).slice(0, 32)}"`, "x-amz-version-id": "version-1" },
      });
    }
    if (method === "DELETE") return xmlError("AccessDenied", 403);
    return xmlError("MethodNotAllowed", 405);
  }

  return { fetcher, store, originalBucket, quarantineBucket };
}

export function iamRoleCredentials() {
  return {
    viewer: testCredentials("viewer"),
    application: testCredentials("application"),
    scanner: testCredentials("scanner"),
    ocr: testCredentials("ocr"),
  };
}
function xmlResponse(root, values) {
  const body = Object.entries(values).map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return new Response(`<${root}>${body}</${root}>`, {
    status: 200, headers: { "content-type": "application/xml" },
  });
}

function requestAccessKey(init) {
  const authorization = String(init.headers?.authorization ?? init.headers?.Authorization ?? "");
  return authorization.match(/Credential=([^/]+)\//)?.[1] ?? "";
}

function xmlRequestValue(text, tag) {
  return text.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1] ?? null;
}

export function fakeLockS3({
  profile = "r2-bucket-lock-pilot-v1",
  bucket = "lock-test",
  lockedPrefix = "locked",
  unlockedPrefix = "unlocked",
  denyUnlockedMutations = false,
  allowLockedMutation = false,
} = {}) {
  const objects = new Map();
  let version = 0;

  async function fetcher(urlValue, init = {}) {
    const url = new URL(urlValue);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const requestBucket = parts.shift();
    const key = parts.join("/");
    const method = init.method ?? "GET";
    const accessKey = requestAccessKey(init);
    if (requestBucket !== bucket) return xmlError("NoSuchBucket", 404);

    if (!key && method === "GET" && url.searchParams.has("versioning")) {
      return xmlResponse("VersioningConfiguration", { Status: "Enabled" });
    }
    if (!key && method === "GET" && url.searchParams.has("object-lock")) {
      return xmlResponse("ObjectLockConfiguration", { ObjectLockEnabled: "Enabled" });
    }

    const current = objects.get(key);
    if (method === "GET" && url.searchParams.has("retention")) {
      if (!current) return xmlError("NoSuchKey", 404);
      return xmlResponse("Retention", {
        Mode: current.retentionMode,
        RetainUntilDate: current.retainUntilDate,
      });
    }
    if (method === "GET" && url.searchParams.has("legal-hold")) {
      if (!current) return xmlError("NoSuchKey", 404);
      return xmlResponse("LegalHold", { Status: current.legalHold ?? "OFF" });
    }

    if (method === "GET" || method === "HEAD") {
      if (!current) return xmlError("NoSuchKey", 404);
      return new Response(method === "HEAD" ? null : current.bytes, {
        status: 200,
        headers: {
          "content-length": String(current.bytes.byteLength),
          etag: `"${sha256(current.bytes).slice(0, 32)}"`,
          "x-amz-version-id": current.versionId,
          ...(current.retentionMode ? { "x-amz-object-lock-mode": current.retentionMode } : {}),
          ...(current.retainUntilDate
            ? { "x-amz-object-lock-retain-until-date": current.retainUntilDate } : {}),
          ...(current.legalHold ? { "x-amz-object-lock-legal-hold": current.legalHold } : {}),
        },
      });
    }

    if (method === "PUT" && url.searchParams.has("retention")) {
      if (accessKey !== "retention-admin" || !current) return xmlError("AccessDenied", 403);
      const text = await new Response(init.body).text();
      const until = xmlRequestValue(text, "RetainUntilDate");
      if (!until || Date.parse(until) < Date.parse(current.retainUntilDate)) {
        return xmlError("AccessDenied", 403);
      }
      current.retentionMode = xmlRequestValue(text, "Mode");
      current.retainUntilDate = until;
      return new Response(null, { status: 200 });
    }
    if (method === "PUT" && url.searchParams.has("legal-hold")) {
      if (accessKey !== "retention-admin" || !current) return xmlError("AccessDenied", 403);
      const text = await new Response(init.body).text();
      current.legalHold = xmlRequestValue(text, "Status");
      return new Response(null, { status: 200 });
    }

    if (method === "PUT") {
      const isLocked = key.startsWith(`${lockedPrefix}/`);
      const isUnlocked = key.startsWith(`${unlockedPrefix}/`);
      if (profile === "r2-bucket-lock-pilot-v1" && accessKey === "lock-probe") {
        if ((isLocked && current && !allowLockedMutation)
            || (isUnlocked && denyUnlockedMutations)) return xmlError("AccessDenied", 403);
      }
      if (accessKey !== "promotion" && accessKey !== "lock-probe") {
        return xmlError("AccessDenied", 403);
      }
      if (init.headers?.["if-none-match"] === "*" && current) {
        return xmlError("PreconditionFailed", 412);
      }
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      const versionId = `version-${++version}`;
      objects.set(key, {
        bytes,
        versionId,
        retentionMode: init.headers?.["x-amz-object-lock-mode"] ?? null,
        retainUntilDate: init.headers?.["x-amz-object-lock-retain-until-date"] ?? null,
        legalHold: init.headers?.["x-amz-object-lock-legal-hold"] ?? "OFF",
      });
      return new Response(null, {
        status: 200,
        headers: { etag: `"${sha256(bytes).slice(0, 32)}"`, "x-amz-version-id": versionId },
      });
    }

    if (method === "DELETE") {
      if (!current) return xmlError("NoSuchKey", 404);
      const isLocked = key.startsWith(`${lockedPrefix}/`);
      const isUnlocked = key.startsWith(`${unlockedPrefix}/`);
      if (profile === "r2-bucket-lock-pilot-v1") {
        if (accessKey !== "lock-probe"
            || (isLocked && !allowLockedMutation)
            || (isUnlocked && denyUnlockedMutations)) return xmlError("AccessDenied", 403);
      } else if (accessKey !== "retention-admin") {
        return xmlError("AccessDenied", 403);
      }
      if (current.legalHold === "ON"
          || (current.retainUntilDate && Date.parse(current.retainUntilDate) > Date.now())) {
        return xmlError("AccessDenied", 403);
      }
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return xmlError("MethodNotAllowed", 405);
  }

  return { fetcher, objects, bucket, lockedPrefix, unlockedPrefix };
}

/**
 * T-09/T-10 için genel aktarma hedefi: izole geri yükleme kovası ya da ikinci
 * sağlayıcı. İmzalı her istek kabul edilir; `if-none-match: *` koşullu ilk
 * yazma sözleşmesi uygulanır. ETag'ler bilinçli olarak kaynaktan farklı üretilir:
 * bütünlük kararının içerik SHA-256'sına dayandığını kanıtlamak için.
 */
export function fakeTransferTarget({ bucket, denyWrites = false, corruptReads = false } = {}) {
  const store = new Map();

  async function fetcher(urlValue, init = {}) {
    const url = new URL(urlValue);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const requestBucket = parts.shift();
    const key = parts.join("/");
    const method = init.method ?? "GET";
    if (requestBucket !== bucket) return xmlError("NoSuchBucket", 404);

    if (method === "GET" || method === "HEAD") {
      const payload = store.get(key);
      if (!payload) return xmlError("NoSuchKey", 404);
      const bytes = Uint8Array.from(payload);
      if (corruptReads) bytes[0] ^= 0xff;
      return new Response(method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
          "content-length": String(bytes.byteLength),
          etag: `"target-${sha256(payload).slice(0, 24)}"`,
          "x-amz-version-id": "target-version-1",
        },
      });
    }
    if (method === "PUT") {
      if (denyWrites) return xmlError("AccessDenied", 403);
      if (init.headers?.["if-none-match"] === "*" && store.has(key)) {
        return xmlError("PreconditionFailed", 412);
      }
      const payload = new Uint8Array(await new Response(init.body).arrayBuffer());
      store.set(key, payload);
      return new Response(null, {
        status: 200,
        headers: {
          etag: `"target-${sha256(payload).slice(0, 24)}"`,
          "x-amz-version-id": "target-version-1",
        },
      });
    }
    return xmlError("AccessDenied", 403);
  }

  return { fetcher, store, bucket };
}
