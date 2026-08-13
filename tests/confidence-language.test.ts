/**
 * Makine güveninin personel diline çevrilmesi.
 *
 * design.md ilke 4: personele `%41` gösterilmez, ne yapması gerektiği
 * gösterilir. `%66` bir memura karar vermez — iki kişi aynı sayıdan farklı
 * sonuç çıkarır ve eşiğin nerede olduğu bilinmez. Sayı ölçüm olarak
 * değerlidir ve API'de kalır; yalnız arayüzde eyleme çevrilir.
 *
 * Kapsanan kabuller:
 * - eşikler risk hesabıyla aynı yerlerden geçer ve sınırlar dahildir;
 * - personel arayüzünde güven yüzdesi biçimlenmez;
 * - API güveni sayı olarak taşımaya devam eder.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { startNodeServer } = await import("../server/app.ts");
const { confidenceBadge, confidencePhrase, technicalConfidence } = await import("../lib/confidence-language.ts");

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const STAFF = "guven@sivas.bel.tr";

test("eşikler risk hesabıyla aynı yerlerden geçer", () => {
  // Personel girdisinde makine belirsizliği yoktur; güven sayısı anlamsızdır.
  assert.equal(confidencePhrase(0.4, "HUMAN"), "personel girişi");
  assert.equal(confidencePhrase(0.99, "HUMAN"), "personel girişi");

  // Sınırlar dahil: 0.90 ve 0.75 `lib/field-policy.ts` risk eşikleridir.
  assert.match(confidencePhrase(0.9, "OCR"), /net okudu/);
  assert.match(confidencePhrase(0.8999, "OCR"), /emin değil — belgeyle karşılaştırın/);
  assert.match(confidencePhrase(0.75, "OCR"), /emin değil — belgeyle karşılaştırın/);
  assert.match(confidencePhrase(0.7499, "OCR"), /bu yazıdan emin değil — belgedeki değeri kontrol edin/);

  // Hiçbir ifade sayı içermez; yoksa kural yarım uygulanmış olur.
  for (const value of [0, 0.3, 0.66, 0.749, 0.75, 0.9, 1]) {
    for (const origin of ["OCR", "HUMAN"] as const) {
      assert.doesNotMatch(confidencePhrase(value, origin), /\d/, `${value}/${origin}`);
    }
  }

  // Dar alanda da aynı karar okunur; üç durum birbirinden ayrıdır.
  assert.deepEqual(
    [0.95, 0.8, 0.5].map((value) => confidenceBadge(value)),
    [{ label: "Net okundu", needsReview: false },
      { label: "Gözden geçirin", needsReview: true },
      { label: "Kontrol edin", needsReview: true }]);
  assert.equal(new Set([0.95, 0.8, 0.5].map((v) => confidenceBadge(v).label)).size, 3);
});

test("teknik görünüm yüzdesi Türkçe biçimlenir ve tek yerden gelir", () => {
  /*
   * design.md §9.3 kararı: ham yüzde yalnız `technical.view` yetkisiyle
   * açılan teknik görünümde belirir ve biçimleme ortak çeviri modülünde
   * durur — yüzeyler sayıyı kendi başına çevirmez (alttaki test bunu
   * kaynak düzeyinde denetlemeye devam eder). Türkçe sayı biçimi: %98,9.
   */
  assert.equal(technicalConfidence(0.989), "%98,9");
  assert.equal(technicalConfidence(1), "%100,0");
  assert.equal(technicalConfidence(0), "%0,0");
});

test("personel arayüzü güven yüzdesi biçimlemez", async () => {
  /*
   * Kural üç ekranda birden geçerli olmalı: alan satırı, ilişki satırı ve
   * belge listesi. Biri kaçarsa personel aynı belgede hem sayı hem cümle
   * görür ve hangisine güveneceğini bilmez. Teknik görünüm (§9.3) bu kuralı
   * esnetmez: yüzeyler yüzdeyi yine kendileri hesaplamaz, ortak modüldeki
   * `technicalConfidence` üzerinden gösterir.
   */
  const yuzeyler = ["app/archive/document-review.tsx", "app/archive/entity-relations.tsx",
    "app/archive/workspace.tsx"];
  for (const path of yuzeyler) {
    const source = await read(path);
    // Büyük/küçük harfe duyarsız: `relationConfidence` da yakalanmalı.
    assert.doesNotMatch(source, /confidence\s*\*\s*100/i, `${path} güveni yüzdeye çeviriyor`);
    assert.doesNotMatch(source, /100\s*\*\s*confidence/i, `${path} güveni yüzdeye çeviriyor`);
    assert.doesNotMatch(source, /%[^\r\n]{0,20}confidence/i, `${path} güveni yüzde olarak yazıyor`);
    assert.match(source, /confidence-language/, `${path} ortak çeviriyi kullanmıyor`);
  }
});

test("API güveni sayı olarak taşımaya devam eder", async () => {
  // Sayı ölçüm olarak değerlidir: OCR'ın nerede zayıf olduğu ancak onunla
  // izlenir. Kural gösterimle ilgilidir, veriyle değil.
  const server = await startNodeServer({
    runtime: {
      dbPath: ":memory:",
      env: {
        ARCHIVE_STORAGE_DRIVER: "local",
        ARCHIVE_LOCAL_STORAGE_DIR: ".wrangler/tmp/guven",
        ARCHIVE_ADMIN_EMAILS: STAFF,
        APP_ENV: "staging",
      },
    },
    host: "127.0.0.1", port: 0, scheduler: false,
  });
  try {
    await server.db.prepare(`INSERT INTO archive_documents
        (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
         document_type, unit, status, uploaded_by, created_at, updated_at)
      VALUES ('d-guven', 'ARS-2026-GVN', 't.pdf', 'k', 'application/pdf', 1024, ?,
        'Numarataj tespit tutanağı', 'İmar ve Şehircilik Müdürlüğü', 'review', ?,
        '2026-03-08T09:00:00.000Z', '2026-03-08T09:00:00.000Z')`)
      .bind("a".repeat(64), STAFF).run();
    await server.db.prepare(`INSERT INTO extracted_fields
        (id, document_id, field_name, value_index, field_value, normalized_value, confidence,
         risk_level, page_number, bbox_json, evidence_text, model, verification_status, origin)
      VALUES ('f-guven', 'd-guven', 'ada', 0, '1284', '1284', 0.66, 'HIGH', 1, '[]', '1284',
        'test', 'SUGGESTED', 'OCR')`).run();

    const response = await fetch(`${server.url}/api/documents/d-guven`,
      { headers: { "oai-authenticated-user-email": STAFF } });
    const body = await response.json() as { fields: Array<{ name: string; confidence: number }> };
    assert.equal(body.fields.find((field) => field.name === "ada")?.confidence, 0.66);
  } finally {
    await server.close();
  }
});
