#!/usr/bin/env node
/**
 * F1.10 — Diske aktarılmış taşınabilir paketi doğrular (tatbikat kanıtı).
 *
 * Kullanım: node scripts/verify-storage-manifest.mjs <paket-dizini>
 * Beklenen düzen: <dizin>/manifest.json ve <dizin>/objects/<nesneId>
 *
 * Her nesnenin SHA-256/boyutu manifestle, manifestin kanonik özeti dosya
 * içeriğiyle ve denetim zinciri bağ bütünlüğü kendi içinde doğrulanır.
 * Sağlayıcı ETag/sürüm kimlikleri bilinçli olarak kullanılmaz (ADR-017).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

async function sha256File(path) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    byteSize += chunk.length;
  }
  return { sha256Hex: hash.digest("hex"), byteSize };
}

function verifyAuditLinkage(chain) {
  let previous = null;
  for (const event of chain) {
    if (!/^[a-f0-9]{64}$/.test(event.eventHash)) return false;
    if (event.eventNumber !== (previous?.eventNumber ?? 0) + 1) return false;
    if ((previous?.eventHash ?? null) !== event.previousHash) return false;
    previous = event;
  }
  return true;
}

const packageDir = process.argv[2];
if (!packageDir) {
  console.error("Kullanım: node scripts/verify-storage-manifest.mjs <paket-dizini>");
  process.exit(2);
}

const failures = [];
const manifestPath = join(packageDir, "manifest.json");
const manifestRaw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw);

const canonical = canonicalJson(manifest);
const storedDigest = createHash("sha256").update(manifestRaw).digest("hex");
const canonicalDigest = createHash("sha256").update(canonical).digest("hex");
if (storedDigest !== canonicalDigest) failures.push("MANIFEST_NOT_CANONICAL");
if (!verifyAuditLinkage(manifest.auditChain ?? [])) failures.push("AUDIT_CHAIN_LINKAGE");

for (const object of manifest.objects ?? []) {
  try {
    const digest = await sha256File(join(packageDir, "objects", object.id));
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
  documentId: manifest.document?.id,
  objectCount: manifest.objects?.length ?? 0,
  manifestDigest: canonicalDigest,
  verified: failures.length === 0,
  failures,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
