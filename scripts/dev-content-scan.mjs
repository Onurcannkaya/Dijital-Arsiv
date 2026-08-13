#!/usr/bin/env node
/**
 * YALNIZ YEREL GELİŞTİRME — içerik tarama taklidi.
 *
 * Gerçek tarama servisi (services/content-scan) qpdf ve ClamAV ister; ikisi de
 * geliştirme makinesinde yoktur ve Docker imajında yaşar. Bu taklit, yerel
 * zincirin (yükleme → tarama → terfi → OCR) çalışabilmesi için `/v1/scan`
 * sözleşmesini uygular ve yapabildiği denetimi GERÇEKTEN yapar:
 *
 * - nesneyi uygulamanın iç ucundan indirir, boyut ve SHA-256'yı yeniden doğrular;
 * - bildirilen türü dosyanın gerçek sihirli baytlarıyla karşılaştırır (K-1'in
 *   yerel karşılığı) — uzantı eşlemesi üretim servisiyle aynı tablodan;
 * - zararlı taraması YAPAMAZ ve bunu gizlemez: alındıya `scannerEngine:
 *   "gelistirme-stub"` yazılır. Denetim kaydına bakan herkes bu belgenin
 *   ClamAV'den geçmediğini görür.
 *
 * Üretime ve kabul koşusuna asla girmez; oralarda gerçek servis koşar.
 *
 * Kullanım:
 *   CONTENT_SCAN_SERVICE_TOKEN=... INTERNAL_FETCH_URL=http://127.0.0.1:3000/api/internal/objects \
 *     node scripts/dev-content-scan.mjs   # 8091 dinler
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { register } from "node:module";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { ACCEPTED_MEDIA_TYPES } = await import("../lib/ingest-contract.ts");

const PORT = Number(process.env.DEV_SCAN_PORT ?? 8091);
const TOKEN = (process.env.CONTENT_SCAN_SERVICE_TOKEN ?? "").trim();
const FETCH_URL = (process.env.INTERNAL_FETCH_URL ?? "http://127.0.0.1:3000/api/internal/objects").replace(/\/$/, "");
if (!TOKEN) {
  console.error("CONTENT_SCAN_SERVICE_TOKEN tanımlı değil; taklit anahtarsız çalışmaz.");
  process.exit(1);
}

/** Üretim servisiyle aynı tespit sırası (services/content-scan/app/file_validation.py). */
function detectMediaType(header) {
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const tiff = header.subarray(0, 4);
  if (tiff.equals(Buffer.from("II*\0", "latin1")) || tiff.equals(Buffer.from("MM\0*", "latin1"))) return "image/tiff";
  const window = header.subarray(0, 1024).toString("latin1");
  const at = window.indexOf("%PDF-");
  if (at >= 0 && window.slice(0, at).trim() === "") return "application/pdf";
  return null;
}

function typeValidation(declared, extension, detected) {
  if (!detected || !ACCEPTED_MEDIA_TYPES[detected]) return "UNSUPPORTED";
  if (declared !== detected || !ACCEPTED_MEDIA_TYPES[detected].includes(extension.toLowerCase())) return "MISMATCH";
  return "MATCH";
}

async function fetchQuarantineObject(objectKey) {
  const query = new URLSearchParams({ scope: "quarantine", key: objectKey });
  const response = await fetch(`${FETCH_URL}?${query}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!response.ok) throw new Error(`iç uç ${response.status} döndürdü`);
  return Buffer.from(await response.arrayBuffer());
}

const server = createServer(async (request, response) => {
  const reply = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  try {
    if (request.method === "GET" && request.url === "/health") {
      // `scannerReady` sağlık denetiminin sözleşmesidir; taklit hazır olduğunu
      // bildirir ama motor adı gerçeği söylemeye devam eder.
      return reply(200, { status: "ok", engine: "gelistirme-stub", scannerReady: true });
    }
    if (request.method !== "POST" || !request.url?.startsWith("/v1/scan")) {
      return reply(404, { detail: "yok" });
    }
    if ((request.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
      return reply(401, { detail: "servis kimliği doğrulanamadı" });
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    const bytes = await fetchQuarantineObject(String(input.objectKey ?? ""));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // Boyut/SHA uyuşmazlığı uydurulmaz: gerçekten ölçülür ve gerçek sonuç döner.
    const detected = detectMediaType(bytes.subarray(0, 4096));
    const result = {
      sha256,
      byteSize: bytes.byteLength,
      detectedMediaType: detected ?? "application/octet-stream",
      typeValidationResult: typeValidation(String(input.declaredMediaType ?? ""),
        String(input.fileExtension ?? ""), detected),
      parserName: "gelistirme-stub",
      parserVersion: "0",
      // Sihirli bayt tespiti başarılıysa biçim en azından başlığıyla tutarlıdır;
      // derin ayrıştırma (qpdf/Pillow) yerelde yoktur ve taklit bunu İDDİA ETMEZ.
      parserResult: detected ? "VALID" : "INVALID",
      scannerEngine: "gelistirme-stub",
      scannerVersion: "clamav-yok",
      scannerSignatureVersion: "yerel-gelistirme",
      scannerResult: "CLEAN",
    };
    console.log(`[dev-scan] ${input.sessionId ?? "?"} ${result.typeValidationResult} ${result.detectedMediaType} ${bytes.byteLength}B`);
    return reply(200, result);
  } catch (error) {
    console.error("[dev-scan] hata:", error instanceof Error ? error.message : error);
    return reply(502, { detail: "tarama taklidi nesneye ulaşamadı" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dev-scan] içerik tarama taklidi 127.0.0.1:${PORT} dinliyor (zararlı taraması YOK)`);
});
