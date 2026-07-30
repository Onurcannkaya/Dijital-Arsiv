import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("kullanıcı arayüzü doğrudan asıl yerine yeniden başlatılabilir kabul API'sini kullanır", async () => {
  const dialog = await read("app/archive/upload-dialog.tsx");
  assert.match(dialog, /fetch\(\"\/api\/uploads\"/);
  assert.match(dialog, /missingParts/);
  assert.match(dialog, /offset \+= 4/);
  assert.match(dialog, /x-content-sha256/);
  assert.match(dialog, /\/complete/);
  assert.doesNotMatch(dialog, /new FormData|fetch\(\"\/api\/documents\"/);
});

test("eski doğrudan-asıl HTTP POST yolu güvenli kabul hattını atlayamaz", async () => {
  const route = await read("app/api/documents/route.ts");
  assert.match(route, /export async function POST\(\)\s*\{\s*return jsonError\("[^"\r\n]+",\s*410\);\s*\}/);
  assert.doesNotMatch(route, /legacyDirectUpload|request\.formData\(\)|objectStorage\.put/);
  const ingest = await read("lib/ingest-service.ts");
  assert.match(ingest, /DELETE FROM upload_part_leases WHERE id = \? AND upload_session_id = \?/);
  assert.doesNotMatch(ingest, /in_flight_parts\s*-\s*1/);
});
