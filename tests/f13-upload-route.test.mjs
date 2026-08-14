import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("kullanıcı arayüzü doğrudan asıl yerine yeniden başlatılabilir kabul API'sini kullanır", async () => {
  /*
   * Zincir §4.4 ile ortak modüle taşındı: masaüstü diyaloğu ve mobil tarama
   * akışı aynı yolu kullanır. Denetim de onunla taşındı — desenler artık
   * upload-core'da aranır ve HER İKİ yüzeyin de onu kullandığı, hiçbirinin
   * kendi yükleme yolu açmadığı doğrulanır.
   */
  const core = await read("app/archive/upload-core.ts");
  assert.match(core, /fetch\(\"\/api\/uploads\"/);
  assert.match(core, /missingParts/);
  assert.match(core, /offset \+= 4/);
  assert.match(core, /x-content-sha256/);
  assert.match(core, /\/complete/);

  for (const surface of ["app/archive/upload-dialog.tsx", "app/archive/mobile-scan.tsx"]) {
    const source = await read(surface);
    assert.match(source, /uploadSecurely/, `${surface} ortak zinciri kullanmıyor`);
    assert.doesNotMatch(source, /new FormData|fetch\(\"\/api\/documents\"|fetch\(\"\/api\/uploads\"/,
      `${surface} kendi yükleme yolunu açmış`);
  }
});

test("eski doğrudan-asıl HTTP POST yolu güvenli kabul hattını atlayamaz", async () => {
  const route = await read("app/api/documents/route.ts");
  assert.match(route, /export async function POST\(\)\s*\{\s*return jsonError\("[^"\r\n]+",\s*410\);\s*\}/);
  assert.doesNotMatch(route, /legacyDirectUpload|request\.formData\(\)|objectStorage\.put/);
  const ingest = await read("lib/ingest-service.ts");
  assert.match(ingest, /DELETE FROM upload_part_leases WHERE id = \? AND upload_session_id = \?/);
  assert.doesNotMatch(ingest, /in_flight_parts\s*-\s*1/);
});
