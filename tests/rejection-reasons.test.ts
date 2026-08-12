/**
 * Ret gerekçesi — sözleşme ve rota davranışı.
 *
 * Denetim izi değişmezdir: bir ret kaydedildikten sonra gerekçesi geriye
 * dönük eklenemez. "Neden reddedildi" sorusu taşınmaz dosyasında yıllar
 * sonra sorulur, o an kaydedilmezse bir daha kaydedilemez.
 *
 * Kapsanan kabuller:
 * - gerekçesiz ret reddedilir (alan ve ilişki, ikisi de);
 * - liste dışı kod kabul edilmez;
 * - `OTHER` serbest açıklamayı zorunlu kılar, aksi halde listeden kaçış olur;
 * - kabul edilen gerekçe koduyla ve etiketiyle denetim izine yazılır.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// Rota modülleri uzantısız import kullanır; kanca kayıttan SONRA yüklenmeli.
register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { FIELD_REJECTION_REASONS, OTHER_REASON_CODE, RELATION_REJECTION_REASONS, validateRejection } =
  await import("../lib/rejection-reasons.ts");
type NodeServer = Awaited<ReturnType<typeof startNodeServer>>;

const STAFF = "gerekce@sivas.bel.tr";
const IDENTITY = { "oai-authenticated-user-email": STAFF };
const JSON_IDENTITY = { ...IDENTITY, "content-type": "application/json" };
const UNIT = "İmar ve Şehircilik Müdürlüğü";
const DOC = "belge-gerekce";
const PARCEL = { blockNo: "1284", parcelNo: "17", districtCode: "5801", cadastralNeighborhood: "KILAVUZ" };

test("gerekçe doğrulaması listeyi ve `Diğer` kuralını uygular", () => {
  const ok = validateRejection({ reasonCode: "MISREAD", reasonNote: "  ada yanlış  " }, FIELD_REJECTION_REASONS);
  assert.notEqual(typeof ok, "string");
  assert.deepEqual(ok, { reasonCode: "MISREAD", reasonLabel: "Yanlış okunmuş (OCR hatası)", reasonNote: "ada yanlış" });

  // Boş, eksik ve liste dışı kodlar reddedilir.
  assert.equal(typeof validateRejection({}, FIELD_REJECTION_REASONS), "string");
  assert.equal(typeof validateRejection({ reasonCode: "   " }, FIELD_REJECTION_REASONS), "string");
  assert.equal(typeof validateRejection({ reasonCode: "UYDURMA" }, FIELD_REJECTION_REASONS), "string");
  // İlişki kodu alan listesinde yoktur; listeler karışmamalıdır.
  assert.equal(typeof validateRejection({ reasonCode: "WRONG_ENTITY" }, FIELD_REJECTION_REASONS), "string");

  /*
   * `OTHER` açıklamasız kabul edilirse listeden kaçış yolu olur ve kontrollü
   * liste anlamsızlaşır: herkes "Diğer" seçip geçer.
   */
  assert.equal(typeof validateRejection({ reasonCode: OTHER_REASON_CODE }, RELATION_REJECTION_REASONS), "string");
  assert.equal(typeof validateRejection({ reasonCode: OTHER_REASON_CODE, reasonNote: "   " }, RELATION_REJECTION_REASONS), "string");
  assert.notEqual(typeof validateRejection(
    { reasonCode: OTHER_REASON_CODE, reasonNote: "Mahkeme kararıyla düşürüldü" }, RELATION_REJECTION_REASONS), "string");
});

async function withServer(run: (server: NodeServer) => Promise<void>) {
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/gerekce",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1",
    port: 0,
    scheduler: false,
  });
  try {
    await server.db.prepare(`INSERT INTO archive_documents
        (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
         document_type, unit, status, uploaded_by, created_at, updated_at)
      VALUES (?, 'ARS-2026-GRK', 'tutanak.pdf', 'test/grk', 'application/pdf', 2048, ?,
        'Numarataj tespit tutanağı', ?, 'review', ?, '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
      .bind(DOC, "f".repeat(64), UNIT, STAFF).run();
    await server.db.prepare(`INSERT INTO extracted_fields
        (id, document_id, field_name, value_index, field_value, normalized_value, confidence,
         risk_level, page_number, bbox_json, evidence_text, model, verification_status, origin)
      VALUES ('deger-1', ?, 'ada', 0, '1284', '1284', 0.68, 'MEDIUM', 1, '[]', '1284', 'test', 'SUGGESTED', 'OCR')`)
      .bind(DOC).run();
    await run(server);
  } finally {
    await server.close();
  }
}

const call = async (server: NodeServer, path: string, method: string, body: unknown) => {
  const response = await fetch(`${server.url}${path}`, {
    method, headers: JSON_IDENTITY, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as { error?: string } };
};

test("gerekçesiz ret hiçbir yoldan kabul edilmez", async () => {
  await withServer(async (server) => {
    const created = await call(server, `/api/documents/${DOC}/relations`, "POST", { parcel: PARCEL });
    const relationId = (created.body as { relations?: Array<{ id: string }> }).relations?.[0].id ?? "";

    const rejected: Array<[label: string, path: string, body: unknown]> = [
      ["alan: gerekçe yok", `/api/documents/${DOC}/fields`,
        { values: [{ id: "deger-1", action: "reject" }] }],
      ["alan: liste dışı kod", `/api/documents/${DOC}/fields`,
        { values: [{ id: "deger-1", action: "reject", reasonCode: "UYDURMA" }] }],
      ["alan: Diğer açıklamasız", `/api/documents/${DOC}/fields`,
        { values: [{ id: "deger-1", action: "reject", reasonCode: OTHER_REASON_CODE }] }],
      ["ilişki: gerekçe yok", `/api/documents/${DOC}/relations`,
        { relations: [{ id: relationId, action: "reject" }] }],
      ["ilişki: liste dışı kod", `/api/documents/${DOC}/relations`,
        { relations: [{ id: relationId, action: "reject", reasonCode: "UYDURMA" }] }],
      ["ilişki: Diğer açıklamasız", `/api/documents/${DOC}/relations`,
        { relations: [{ id: relationId, action: "reject", reasonCode: OTHER_REASON_CODE }] }],
    ];
    for (const [label, path, body] of rejected) {
      const response = await call(server, path, "PATCH", body);
      assert.equal(response.status, 400, label);
      assert.ok(response.body.error, `${label} gerekçesiz reddedildi`);
    }

    // Hiçbiri kaydı değiştirmemiş olmalı.
    const value = await server.db.prepare("SELECT verification_status FROM extracted_fields WHERE id = 'deger-1'")
      .first<{ verification_status: string }>();
    assert.equal(value?.verification_status, "SUGGESTED");
  });
});

test("kabul edilen gerekçe koduyla ve etiketiyle denetim izine yazılır", async () => {
  await withServer(async (server) => {
    const accepted = await call(server, `/api/documents/${DOC}/fields`, "PATCH",
      { values: [{ id: "deger-1", action: "reject", reasonCode: "MISREAD", reasonNote: "Ada 1285 olmalı" }] });
    assert.equal(accepted.status, 200);

    const event = await server.db.prepare(`SELECT details_json FROM audit_events
      WHERE document_id = ? ORDER BY event_number DESC LIMIT 1`).bind(DOC).first<{ details_json: string }>();
    const changes = (JSON.parse(event?.details_json ?? "{}") as {
      changes?: Array<{ action: string; reasonCode?: string; reasonLabel?: string; reasonNote?: string }> }).changes ?? [];
    const rejection = changes.find((change) => change.action === "reject");
    assert.ok(rejection, "ret olayı yazılmadı");
    assert.equal(rejection.reasonCode, "MISREAD");
    /*
     * Etiket de yazılır: kod listesi ileride değişse ya da bir kod kaldırılsa
     * bile denetçi, kararın verildiği andaki gerekçenin ne anlama geldiğini
     * okuyabilmelidir.
     */
    assert.equal(rejection.reasonLabel, "Yanlış okunmuş (OCR hatası)");
    assert.equal(rejection.reasonNote, "Ada 1285 olmalı");
  });
});
