#!/usr/bin/env node
/**
 * Yerel geliştirme için gerçekçi belge verisi üretir.
 *
 * Lokalde OCR ve içerik tarama servisleri çalışmadığı için kabul hattı
 * belgeleri karantinada bırakır; liste, arama, doğrulama ve belge inceleme
 * ekranları boş kalır. Bu betik o boşluğu doldurur: farklı durumlarda
 * belgeler, OCR sayfaları, doğrulama bekleyen alan değerleri, varlık
 * ilişkileri ve denetim olayları yazar.
 *
 * YALNIZ GELİŞTİRME. Hedef veritabanı `.wrangler/` (Miniflare D1) ya da
 * `data/` (Node çalışma zamanı) altında olmak zorundadır; başka bir yol
 * verildiğinde betik çalışmayı reddeder. Üretilen kişi adları ve adresler
 * tamamen kurgusaldır.
 *
 * Kullanım:
 *   node scripts/seed-dev-data.mjs                # Miniflare D1'i bulur
 *   node scripts/seed-dev-data.mjs --db data/arsiv.db
 *
 * Betik idempotenttir: aynı tohum belgesi ikinci kez yazılmaz. Kayıtları
 * geri almak için tohum SİLİNMEZ — denetim olayları değişmezdir ve silme
 * tetikleyiciyle reddedilir (belge silmesi de zincire takılır). Temiz
 * başlangıç için `.wrangler/state/v3/d1` dizini silinip göç yeniden
 * çalıştırılır (deploy/kurum-ici/LOKAL_GELISTIRME.md).
 */

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { createNodeSqliteD1 } from "../lib/node-sqlite-d1.ts";
import { writeAuditEvent } from "../lib/audit.ts";
import { normalizeSearch } from "../lib/text-search.ts";

const SEED_MARK = "seed-dev";
const UPLOADER = "yerel-pilot@sivas.bel.tr";
const REVIEWER = "memur@sivas.bel.tr";

function findMiniflareDatabase() {
  const root = resolve("./.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  const files = readdirSync(root).filter((name) => name.endsWith(".sqlite") && !name.startsWith("metadata"));
  if (!files.length) throw new Error("Miniflare D1 veritabanı bulunamadı; önce `npm run dev` ile bir kez açın.");
  return join(root, files[0]);
}

function resolveTarget() {
  const index = process.argv.indexOf("--db");
  const path = resolve(index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : findMiniflareDatabase());
  const allowed = [resolve("./.wrangler"), resolve("./data")];
  if (!allowed.some((prefix) => path.startsWith(prefix + sep))) {
    throw new Error(`Güvenlik: yalnız .wrangler/ veya data/ altındaki geliştirme veritabanına yazılır (verilen: ${path}).`);
  }
  return path;
}

/** Kurgusal ama tutarlı belge kümesi; her biri akışın farklı bir durumunu gösterir. */
const documents = [
  {
    key: "encumen-arsiv", type: "ENCUMEN_KARARI", typeName: "Encümen karar sureti",
    unit: "Emlak ve İstimlak Müdürlüğü", status: "archived", name: "encumen-karari-2019-katilim-payi.pdf",
    neighborhood: "Kılavuz", ada: "1284", parcel: "17", date: "11.04.2019",
    addressee: "Kurgu İnşaat Ltd. Şti.", confidence: 0.96, pages: 2, verified: true,
    text: "SİVAS BELEDİYESİ ENCÜMEN KARARI Karar No 2019/318 Kılavuz Mahallesi 1284 ada 17 parsel üzerinde yol katılım payı düzenlenmesine oybirliğiyle karar verilmiştir.",
  },
  {
    key: "yapi-kullanma-ready", type: "YAPI_KULLANMA_IZNI", typeName: "Yapı kullanma izin belgesi",
    unit: "İmar ve Şehircilik Müdürlüğü", status: "ready", name: "yapi-kullanma-izni-2021-b-blok.pdf",
    neighborhood: "Yenişehir", ada: "3170", parcel: "4", date: "27.09.2021",
    addressee: "Örnek Yapı A.Ş.", confidence: 0.83, pages: 3, pending: ["addressee", "document_date"],
    text: "YAPI KULLANMA İZİN BELGESİ Yenişehir Mahallesi 3170 ada 4 parsel B blok için düzenlenmiştir. Yapı sınıfı 3A, toplam 24 bağımsız bölüm.",
  },
  {
    key: "isyeri-ruhsat-review", type: "ISYERI_ACMA_RUHSATI", typeName: "İşyeri açma ruhsatı",
    unit: "Ruhsat ve Denetim Müdürlüğü", status: "review", name: "isyeri-acma-ruhsati-2023-lokanta.pdf",
    neighborhood: "Esentepe", ada: "905", parcel: "62", date: "14.02.2023",
    addressee: "Deneme Gıda İşletmeciliği", confidence: 0.71, pages: 1, pending: ["neighborhood", "ada", "parcel"],
    text: "İŞYERİ AÇMA VE ÇALIŞMA RUHSATI Esentepe Mahallesi 905 ada 62 parselde lokanta faaliyeti için verilmiştir. Sınıf 2. sınıf gayrisıhhi müessese.",
  },
  {
    key: "numarataj-processing", type: "NUMARATAJ_TUTANAGI", typeName: "Numarataj tespit tutanağı",
    unit: "İmar ve Şehircilik Müdürlüğü", status: "processing", name: "numarataj-tutanagi-2024.pdf",
    neighborhood: "Gültepe", ada: "2205", parcel: "9", date: "03.06.2024",
    addressee: "", confidence: 0, pages: 0,
    text: "",
  },
  {
    key: "yangin-queued", type: "YANGIN_GUVENLIK_RAPORU", typeName: "Yangın güvenlik raporu",
    unit: "İtfaiye Müdürlüğü", status: "queued", name: "yangin-guvenlik-raporu-2025.pdf",
    neighborhood: "Mimar Sinan", ada: "778", parcel: "31", date: "20.01.2025",
    addressee: "", confidence: 0, pages: 0,
    text: "",
  },
  {
    key: "yapi-kullanma-failed", type: "YAPI_KULLANMA_IZNI", typeName: "Yapı kullanma izin belgesi",
    unit: "Yapı Kontrol Müdürlüğü", status: "ocr_failed", name: "yapi-kullanma-izni-1998-tarama.pdf",
    neighborhood: "Alibaba", ada: "412", parcel: "5", date: "02.11.1998",
    addressee: "", confidence: 0, pages: 0, failure: "Tarama çözünürlüğü düşük; sayfa yönü tespit edilemedi.",
    text: "",
  },
  {
    // İlişki doğrulama/reddetme akışı için: OCR önerisi yanlış parseli işaret
    // ediyor; personel ilişkiyi reddedip doğrusunu elle ekler.
    key: "numarataj-iliski-review", type: "NUMARATAJ_TUTANAGI", typeName: "Numarataj tespit tutanağı",
    unit: "İmar ve Şehircilik Müdürlüğü", status: "review", name: "numarataj-tutanagi-2022-kilavuz.pdf",
    neighborhood: "Kılavuz", ada: "1284", parcel: "17", date: "08.03.2022",
    addressee: "", confidence: 0.68, pages: 1, pending: ["ada", "parcel"],
    text: "NUMARATAJ TESPİT TUTANAĞI Kılavuz Mahallesi 1284 ada 17 parselde bulunan yapıya numarataj verilmiştir.",
  },
  {
    key: "encumen-yazi-arsiv", type: "ENCUMEN_KARARI", typeName: "Encümen karar sureti",
    unit: "Yazı İşleri Müdürlüğü", status: "archived", name: "encumen-karari-2022-tahsis.pdf",
    neighborhood: "Halilağa", ada: "56", parcel: "104", date: "19.07.2022",
    addressee: "Sivas Belediyesi", confidence: 0.94, pages: 1, verified: true,
    text: "ENCÜMEN KARARI Karar No 2022/145 Halilağa Mahallesi 56 ada 104 parselde bulunan taşınmazın tahsisi görüşülerek kabul edilmiştir.",
  },
];

function fieldRows(document, documentId, typeId) {
  const base = [
    ["document_type", document.typeName, 0.99],
    ["unit", document.unit, 0.97],
    ["document_date", document.date, 0.92],
    ["neighborhood", document.neighborhood, 0.9],
    ["ada", document.ada, 0.94],
    ["parcel", document.parcel, 0.94],
  ];
  if (document.addressee) base.push(["addressee", document.addressee, 0.78]);
  return base.map(([name, value, confidence]) => {
    const pending = (document.pending ?? []).includes(name);
    const verified = document.verified && !pending;
    return {
      id: randomUUID(),
      documentId,
      typeId,
      name,
      value,
      confidence: pending ? Math.min(confidence, 0.66) : confidence,
      risk: pending ? "HIGH" : confidence < 0.85 ? "MEDIUM" : "LOW",
      // extracted_fields sözlüğü: SUGGESTED | CONFIRMED | CORRECTED | REJECTED
      // (varlık ilişkilerindeki VERIFIED'dan farklıdır).
      status: pending ? "SUGGESTED" : verified ? "CONFIRMED" : "SUGGESTED",
      // value_index çok değerli alanda değerin sırasıdır; her alan kendi
      // dizisinde 0'dan başlar (alanlar arası sayaç değildir).
      index: 0,
    };
  });
}

async function seed(db) {
  const types = await db.prepare("SELECT id, code, name, profile_version FROM document_types").all();
  const typeByCode = new Map((types.results ?? []).map((row) => [row.code, row]));
  const now = Date.now();
  let created = 0;

  for (const [index, document] of documents.entries()) {
    const existing = await db.prepare("SELECT id FROM archive_documents WHERE storage_key = ?")
      .bind(`${SEED_MARK}/${document.key}`).first();
    if (existing) continue;

    const type = typeByCode.get(document.type);
    const documentId = randomUUID();
    const binaryId = randomUUID();
    const createdAt = new Date(now - (index + 1) * 3600_000).toISOString();
    const reference = `ARS-${new Date(createdAt).getUTCFullYear()}-${documentId.slice(0, 8).toUpperCase()}`;
    const sha = randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);

    await db.prepare(`INSERT INTO archive_documents
        (id, reference_no, original_name, storage_key, media_type, byte_size, sha256,
         document_type, document_type_id, document_profile_version, unit, status,
         uploaded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(documentId, reference, document.name, `${SEED_MARK}/${document.key}`,
        180_000 + index * 24_000, sha, document.typeName, type?.id ?? null,
        type?.profile_version ?? null, document.unit, document.status,
        UPLOADER, createdAt, createdAt).run();

    await db.prepare(`INSERT INTO binary_objects
        (id, document_id, object_class, object_key, media_type, byte_size, sha256, generator, created_at)
      VALUES (?, ?, 'original', ?, 'application/pdf', ?, ?, 'ingest-promotion', ?)`)
      .bind(binaryId, documentId, `originals/${documentId}/${binaryId}`,
        180_000 + index * 24_000, sha, createdAt).run();

    await writeAuditEvent(db, {
      documentId, actor: "system:ingest-promotion", action: "document.received",
      details: { referenceNo: reference, objectClass: "original" },
    });

    // OCR sayfaları ve alan değerleri yalnız OCR'ı tamamlanmış belgelerde olur.
    if (document.pages > 0) {
      for (let page = 1; page <= document.pages; page += 1) {
        const text = page === 1 ? document.text : `${document.text} (sayfa ${page})`;
        await db.prepare(`INSERT INTO ocr_pages
            (id, document_id, page_number, width, height, raw_text, full_text, search_text,
             confirmed_text, confirmed_by, confirmed_at, words_json, average_confidence, model, created_at)
          VALUES (?, ?, ?, 1240, 1754, ?, ?, ?, ?, ?, ?, '[]', ?, 'paddleocr-local', ?)`)
          .bind(randomUUID(), documentId, page, text, text, normalizeSearch(text),
            document.verified ? text : null, document.verified ? REVIEWER : null,
            document.verified ? createdAt : null, document.confidence, createdAt).run();
      }
      await writeAuditEvent(db, {
        documentId, actor: "system:ocr", action: "ocr.completed",
        details: { pageCount: String(document.pages) },
      });

      for (const field of fieldRows(document, documentId, type?.id ?? null)) {
        await db.prepare(`INSERT INTO extracted_fields
            (id, document_id, field_name, value_index, field_value, normalized_value, confidence,
             risk_level, page_number, bbox_json, evidence_text, model, verification_status, origin,
             verified_by, verified_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '[]', ?, 'paddleocr-local', ?, 'OCR', ?, ?, ?, ?)`)
          .bind(field.id, documentId, field.name, field.index, field.value,
            normalizeSearch(String(field.value)), field.confidence, field.risk,
            field.value, field.status,
            field.status === "CONFIRMED" ? REVIEWER : null,
            field.status === "CONFIRMED" ? createdAt : null, createdAt, createdAt).run();
      }

      // Ada/parsel varlığı ve belge ilişkisi: arama ve ilişki ekranı için.
      //
      // Parsel varlığı kimliğiyle tekildir (parcel_entities_identity_unique):
      // aynı parsele ait ikinci belge YENİ varlık üretmez, mevcut olana
      // bağlanır. Gerçek arşivde de bir parselin birden çok belgesi olur.
      const neighbourhoodCode = document.neighborhood.toLocaleUpperCase("tr");
      const existingParcel = await db.prepare(`SELECT entity_id FROM parcel_entities
        WHERE district_code = '5801' AND cadastral_neighborhood = ? AND block_no = ? AND parcel_no = ?`)
        .bind(neighbourhoodCode, document.ada, document.parcel).first();
      const entityId = existingParcel?.entity_id ?? randomUUID();
      const label = `${document.ada} ada ${document.parcel} parsel`;
      if (!existingParcel) {
        await db.prepare(`INSERT INTO entities
            (id, entity_type, display_label, authority_source, entity_status, created_by, created_at, updated_at)
          VALUES (?, 'PARCEL', ?, 'ARCHIVE', 'PROVISIONAL', ?, ?, ?)`)
          .bind(entityId, label, UPLOADER, createdAt, createdAt).run();
        await db.prepare(`INSERT INTO parcel_entities
            (entity_id, district_code, cadastral_neighborhood, block_no, parcel_no, parcel_status)
          VALUES (?, '5801', ?, ?, ?, 'ACTIVE')`)
          .bind(entityId, neighbourhoodCode, document.ada, document.parcel).run();
      }
      await db.prepare(`INSERT INTO document_entity_relations
          (id, document_id, entity_id, relation_type, relation_source, relation_confidence,
           verification_status, verified_by, verified_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'SUBJECT', ?, ?, ?, ?, ?, ?, ?, ?)`)
        // relation_source sözlüğü: GIS | HUMAN | OCR | INTEGRATION | SPATIAL
        .bind(randomUUID(), documentId, entityId, document.verified ? "HUMAN" : "OCR",
          document.confidence, document.verified ? "VERIFIED" : "SUGGESTED",
          document.verified ? REVIEWER : null, document.verified ? createdAt : null,
          UPLOADER, createdAt, createdAt).run();
    }

    if (document.status === "archived") {
      await writeAuditEvent(db, {
        documentId, actor: REVIEWER, action: "fields.confirmed",
        details: { confirmed: "all" },
      });
      await writeAuditEvent(db, {
        documentId, actor: REVIEWER, action: "document.archived", details: {},
      });
    }
    if (document.status === "queued" || document.status === "processing" || document.status === "ocr_failed") {
      await db.prepare(`INSERT INTO processing_jobs
          (id, document_id, kind, status, attempt, max_attempts, model, error_message, created_at, updated_at)
        VALUES (?, ?, 'ocr', ?, ?, 3, 'paddleocr-local', ?, ?, ?)`)
        .bind(randomUUID(), documentId, document.status === "ocr_failed" ? "failed"
          : document.status === "processing" ? "processing" : "queued",
          document.status === "ocr_failed" ? 3 : document.status === "processing" ? 1 : 0,
          document.failure ?? null, createdAt, createdAt).run();
    }
    created += 1;
  }
  return created;
}

const target = resolveTarget();
const db = createNodeSqliteD1({ path: target });
try {
  const created = await seed(db);
  const total = await db.prepare("SELECT COUNT(*) AS count FROM archive_documents").first();
  console.log(`tohum tamam: ${created} yeni belge yazıldı, toplam ${total?.count ?? 0} belge.`);
  console.log(`veritabanı: ${target}`);
} finally {
  db.close();
}
