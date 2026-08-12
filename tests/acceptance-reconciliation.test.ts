import assert from "node:assert/strict";
import test from "node:test";

import { runAcceptanceReconciliationProbe } from "../lib/acceptance-reconciliation.ts";
import { applyArchiveMigrations } from "../lib/archive-schema.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

class FakeR2 {
  objects = new Map<string, {
    bytes: Uint8Array; uploaded: Date; customMetadata?: Record<string, string>;
  }>();

  object(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.bytes.byteLength,
      etag: `etag-${key}`,
      version: "v1",
      uploaded: stored.uploaded,
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: stored.customMetadata,
      checksums: {},
    };
  }

  async put(key: string, value: Uint8Array | ArrayBuffer, options: {
    onlyIf?: { etagDoesNotMatch?: string };
    customMetadata?: Record<string, string>;
  } = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { bytes, uploaded: new Date("2026-07-31T12:00:00.000Z"), customMetadata: options.customMetadata });
    return this.object(key);
  }

  async head(key: string) { return this.object(key); }
  async delete(key: string) { this.objects.delete(key); }
  async list() { return { objects: [...this.objects.keys()].sort().map((key) => this.object(key)), truncated: false }; }
}

test("T-12 probu sahipsiz ve dosyas?z y?nleri bulur, gen? kontrol? susturur", async () => {
  const db = createSqliteD1();
  await applyArchiveMigrations(db);
  const archive = new FakeR2();
  try {
    const result = await runAcceptanceReconciliationProbe({
      db,
      archive: archive as unknown as R2Bucket,
      sessionId: "acceptance-session-t12",
      now: () => new Date("2026-07-31T12:00:00.000Z"),
    });
    assert.equal(result.run.status, "COMPLETED");
    assert.equal(result.findings.length, 2);
    assert.deepEqual(result.findings.map((finding) => finding.findingType).sort(),
      ["MISSING_OBJECT", "ORPHAN_OBJECT"]);
    assert.ok(result.findings.every((finding) => finding.status === "OPEN"));
    assert.equal(result.expectations.youngControlFindingCount, 0);
    assert.equal(result.expectations.orphanObjectStillPresent, true);
    assert.ok(result.run.binarySnapshotMaxRowid > 0);
    assert.ok(result.run.documentSnapshotMaxRowid > 0);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /acceptance\/reconciliation\//);
    assert.match(result.expectations.orphanKeyDigest, /^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});
