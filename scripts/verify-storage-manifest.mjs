#!/usr/bin/env node
/**
 * F1.10 — Diske aktarılmış taşınabilir paketi güvenilir dış özetle doğrular.
 *
 * Kullanım:
 *   node scripts/verify-storage-manifest.mjs <paket-dizini> <beklenen-manifest-sha256>
 *
 * Beklenen özet paketle aynı ortamdan alınmamalıdır; yedek kataloğu veya
 * değiştirilemez denetim kaydı güven kökü olarak kullanılmalıdır.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const PACKAGE_VERSION = "portable-package-v2";
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function auditCanonicalize(value) {
  if (Array.isArray(value)) return value.map(auditCanonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, auditCanonicalize(entry)]));
  }
  return value;
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    byteSize += chunk.length;
  }
  return { sha256Hex: hash.digest("hex"), byteSize };
}

function safeChild(root, ...parts) {
  for (const part of parts) {
    if (!SAFE_ID.test(part)) throw new Error("Güvenli olmayan paket nesne kimliği.");
  }
  const child = resolve(root, ...parts);
  const normalizedRoot = resolve(root);
  if (!child.startsWith(`${normalizedRoot}${sep}`)) throw new Error("Paket yolu kök dışına çıkıyor.");
  return child;
}

function validateManifest(manifest) {
  if (!manifest || manifest.packageVersion !== PACKAGE_VERSION || !manifest.document
    || !Array.isArray(manifest.objects) || !Array.isArray(manifest.auditChain)) {
    throw new Error("Desteklenmeyen veya eksik paket manifesti.");
  }
  if (!SAFE_ID.test(manifest.document.id) || !SHA256.test(manifest.document.sha256)) {
    throw new Error("Belge kimliği veya özeti geçersiz.");
  }
  const ids = new Set();
  for (const object of manifest.objects) {
    if (!SAFE_ID.test(object.id) || ids.has(object.id) || !SHA256.test(object.sha256)
      || !Number.isSafeInteger(object.byteSize) || object.byteSize < 0) {
      throw new Error("Paket nesne sözleşmesi geçersiz.");
    }
    ids.add(object.id);
  }
  const originals = manifest.objects.filter((object) => object.objectClass === "original");
  if (originals.length !== 1) throw new Error("Paket tam olarak bir asıl nesne içermiyor.");
  const original = originals[0];
  if (original.sha256 !== manifest.document.sha256
    || original.byteSize !== manifest.document.byteSize
    || original.mediaType !== manifest.document.mediaType) {
    throw new Error("Belge kaydı asıl nesneyle uyuşmuyor.");
  }
  for (const object of manifest.objects) {
    if (object.derivedFromId !== null && !ids.has(object.derivedFromId)) {
      throw new Error("Türev kaynağı pakette bulunmuyor.");
    }
  }
  if (!manifest.auditChain.length) throw new Error("Paket denetim zinciri içermiyor.");
}

function verifyAuditChain(documentId, chain) {
  let previous = null;
  for (const event of chain) {
    if (!SHA256.test(event.eventHash)
      || event.eventNumber !== (previous?.eventNumber ?? 0) + 1
      || (previous?.eventHash ?? null) !== event.previousHash) return false;
    const payload = JSON.stringify({
      documentId,
      eventNumber: event.eventNumber,
      actor: event.actor,
      action: event.action,
      details: auditCanonicalize(event.details),
      previousHash: event.previousHash,
      createdAt: event.createdAt,
    });
    if (sha256Text(payload) !== event.eventHash) return false;
    previous = event;
  }
  return chain.length > 0;
}

const packageDir = process.argv[2];
const expectedDigest = process.argv[3]?.toLowerCase();
if (!packageDir || !expectedDigest || !SHA256.test(expectedDigest)) {
  console.error("Kullanım: node scripts/verify-storage-manifest.mjs <paket-dizini> <beklenen-manifest-sha256>");
  process.exit(2);
}

const failures = [];
const root = resolve(packageDir);
const manifestPath = join(root, "manifest.json");
const manifestStat = await stat(manifestPath);
if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error("Manifest boyut sınırını aşıyor.");
const manifestRaw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw);
validateManifest(manifest);

const canonical = canonicalJson(manifest);
const storedDigest = sha256Text(manifestRaw);
if (manifestRaw !== canonical) failures.push("MANIFEST_NOT_CANONICAL");
if (storedDigest !== expectedDigest) failures.push("MANIFEST_TRUST_DIGEST_MISMATCH");
if (!verifyAuditChain(manifest.document.id, manifest.auditChain)) failures.push("AUDIT_CHAIN_HASH");

for (const object of manifest.objects) {
  try {
    const digest = await sha256File(safeChild(root, "objects", object.id));
    if (digest.sha256Hex !== object.sha256 || digest.byteSize !== object.byteSize) {
      failures.push(`OBJECT_SHA_MISMATCH:${object.id}`);
    }
  } catch {
    failures.push(`OBJECT_MISSING:${object.id}`);
  }
}

const summary = {
  packageVersion: manifest.packageVersion,
  schemaVersion: manifest.schemaVersion,
  documentId: manifest.document.id,
  objectCount: manifest.objects.length,
  manifestDigest: storedDigest,
  trustedDigestMatched: storedDigest === expectedDigest,
  verified: failures.length === 0,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
