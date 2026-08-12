import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ARCHIVE_SCHEMA_VERSION,
  applyArchiveMigrations,
  readSchemaVersion,
} from "../lib/archive-schema.ts";
import { createSqliteD1 } from "./sqlite-d1.ts";

const SAME_SHA = "f".repeat(64);

test("sürüm 7 yükseltmesi mükerrer asıl SHA bulursa damgalamaz; düzeltildikten sonra yinelenebilir", async () => {
  const db = createSqliteD1();
  try {
    await applyArchiveMigrations(db);
    const initialIndexes = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>;
    assert.ok(!initialIndexes.some((index) => index.name === "archive_documents_sha256_unique"));
    db.raw.exec("DROP INDEX binary_objects_original_sha256_unique");
    const document = (id: string, sha: string) => db.raw.prepare(`INSERT INTO archive_documents
      (id, reference_no, original_name, storage_key, media_type, byte_size, sha256, uploaded_by)
      VALUES (?, ?, 'a.pdf', ?, 'application/pdf', 10, ?, 'a@b')`)
      .run(id, `ARS-${id}`, `originals/${id}`, sha);
    document("d1", "1".repeat(64));
    document("d2", "2".repeat(64));
    db.raw.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('o1', 'd1', 'original', 'vault/o1', 'application/pdf', 10, ?)`).run(SAME_SHA);
    db.raw.prepare(`INSERT INTO binary_objects
      (id, document_id, object_class, object_key, media_type, byte_size, sha256)
      VALUES ('o2', 'd2', 'original', 'vault/o2', 'application/pdf', 10, ?)`).run(SAME_SHA);
    db.raw.prepare("UPDATE schema_state SET version = 7 WHERE id = 'archive'").run();

    await assert.rejects(() => applyArchiveMigrations(db));
    assert.equal(await readSchemaVersion(db), 7, "başarısız F1.2 göçü sürümü ilerletti");

    db.raw.prepare("DELETE FROM binary_objects WHERE id = 'o2'").run();
    const retried = await applyArchiveMigrations(db);
    assert.deepEqual(retried, { applied: true, from: 7, to: ARCHIVE_SCHEMA_VERSION });
    assert.equal(await readSchemaVersion(db), ARCHIVE_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("üretim nesne okumasında archive_documents.storage_key fallback bulunmaz", async () => {
  const source = await readFile(new URL("../lib/binary-objects.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /SELECT\s+storage_key\s+AS\s+object_key/i);
  assert.match(source, /FROM binary_objects/);
});
