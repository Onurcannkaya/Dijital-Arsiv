/**
 * T-09/T-10 — F1.10 taşınabilir paketinin kabul koşusu tarafındaki ortak işleri.
 *
 * Manifest, staging kanıt ucundan alınır ve özeti KOŞUCU tarafında yeniden
 * hesaplanır: paketle aynı ortamdan gelen özet tek başına güven kökü sayılmaz
 * (ADR-017). Fiziksel nesne anahtarları yalnız süreç belleğinde kullanılır;
 * kanıt dosyalarına anahtar değil SHA-256 özetleri yazılır.
 */

import { canonicalJson } from "../phase-one-acceptance-core.mjs";
import { sha256Hex } from "./fixtures.mjs";
import { createS3Client } from "./s3-contract.mjs";

export function acceptanceToken(ctx) {
  return ctx.config.acceptanceToken ?? ctx.acceptanceToken;
}

/**
 * Kanıt ucundan manifesti çeker ve özetini yerel kanonik JSON ile doğrular.
 * Dönen `digestVerified` false ise çağıran yürütücü PASS üretemez.
 */
export async function fetchPortableManifest(client, ctx, sessionId) {
  const token = acceptanceToken(ctx);
  const response = await client.json("POST",
    `/api/admin/acceptance-evidence/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${token}` },
      body: { action: "EXPORT_PORTABLE_MANIFEST" },
    });
  if (!response.ok || !response.body?.manifest) {
    return { ok: false, status: response.status };
  }
  const { documentId, manifest, manifestDigest, objectLocators } = response.body;
  const recomputedDigest = sha256Hex(Buffer.from(canonicalJson(manifest), "utf8"));
  return {
    ok: true,
    status: response.status,
    documentId,
    manifest,
    manifestText: canonicalJson(manifest),
    manifestDigest: recomputedDigest,
    digestVerified: recomputedDigest === manifestDigest,
    reportedDigest: manifestDigest,
    objectLocators: Array.isArray(objectLocators) ? objectLocators : [],
  };
}

function sourceBucketFor(namespace, s3) {
  if (namespace === "ARCHIVE_FILES") return s3?.originalBucket ?? null;
  if (namespace === "QUARANTINE_FILES") return s3?.quarantineBucket ?? null;
  if (namespace === "DERIVATIVE_FILES") return s3?.derivativeBucket ?? null;
  return null;
}

/**
 * Manifestteki her nesneyi kaynak sağlayıcıdan okur ve içerik SHA-256 +
 * boyutunu manifest kanıtıyla karşılaştırır. Sonuç nesne baytlarını taşır;
 * çağıran hedefe aktarır. Hata `{ errorCode }` ile erken döner.
 */
export async function readPackageObjects(ctx, pkg, errorPrefix) {
  const s3 = ctx.config.s3;
  const clients = new Map();
  const objects = [];
  for (const locator of pkg.objectLocators) {
    const bucket = sourceBucketFor(locator.namespace, s3);
    if (!bucket) {
      return {
        errorCode: `${errorPrefix}_SOURCE_NAMESPACE_UNSUPPORTED`,
        detail: { namespace: locator.namespace ?? null, objectClass: locator.objectClass ?? null },
      };
    }
    if (!clients.has(bucket)) {
      clients.set(bucket, createS3Client({
        endpoint: s3.endpoint,
        bucket,
        region: s3.region,
        credentials: s3.credentials,
        signal: ctx.signal,
        fetcher: s3.fetcher,
      }));
    }
    const read = await clients.get(bucket).get(locator.objectKey);
    const manifestObject = pkg.manifest.objects.find((object) => object.id === locator.id);
    const sha256 = read.ok ? sha256Hex(read.bytes) : null;
    if (!read.ok || !manifestObject || sha256 !== manifestObject.sha256
      || read.bytes.byteLength !== manifestObject.byteSize) {
      return {
        errorCode: `${errorPrefix}_SOURCE_OBJECT_MISMATCH`,
        detail: {
          objectClass: locator.objectClass ?? null,
          readStatus: read.status,
          keyDigest: sha256Hex(Buffer.from(String(locator.objectKey ?? ""))),
        },
      };
    }
    objects.push({
      id: locator.id,
      objectClass: locator.objectClass,
      mediaType: manifestObject.mediaType,
      byteSize: manifestObject.byteSize,
      sha256: manifestObject.sha256,
      sourceEtag: read.etag,
      bytes: read.bytes,
    });
  }
  return { objects };
}

/**
 * Paketi (nesneler + manifest) hedef adaptöre koşullu ilk yazmayla aktarır,
 * ardından hedeften TAM okuyup yalnız içerik SHA-256/boyut ile doğrular.
 * Sağlayıcı ETag/sürüm kimliği karara girmez; yalnız rapor edilir.
 */
export async function transferAndVerifyPackage(target, prefix, pkg, objects) {
  const transfers = [];
  for (const object of objects) {
    const key = `${prefix}/objects/${object.id}`;
    const written = await target.putIfAbsent(key, object.bytes);
    if (!written.ok) {
      return { failed: { stage: "write", objectClass: object.objectClass, status: written.status, code: written.code } };
    }
    const readBack = await target.get(key);
    const sha256 = readBack.ok ? sha256Hex(readBack.bytes) : null;
    transfers.push({
      objectClass: object.objectClass,
      byteSize: object.byteSize,
      shaMatches: sha256 === object.sha256 && readBack.ok
        && readBack.bytes.byteLength === object.byteSize,
      // ETag'ler yalnız gözlemdir: karar içerik SHA-256'sıyla verilir.
      sourceEtagObserved: Boolean(object.sourceEtag),
      targetEtagObserved: Boolean(readBack.etag),
      etagsEqual: Boolean(object.sourceEtag) && object.sourceEtag === readBack.etag,
    });
  }
  const manifestKey = `${prefix}/manifest.json`;
  const manifestBytes = Buffer.from(pkg.manifestText, "utf8");
  const manifestWrite = await target.putIfAbsent(manifestKey, manifestBytes);
  if (!manifestWrite.ok) {
    return { failed: { stage: "manifest-write", status: manifestWrite.status, code: manifestWrite.code } };
  }
  const manifestBack = await target.get(manifestKey);
  const manifestShaMatches = manifestBack.ok
    && sha256Hex(manifestBack.bytes) === pkg.manifestDigest;
  return { transfers, manifestKey, manifestShaMatches };
}
