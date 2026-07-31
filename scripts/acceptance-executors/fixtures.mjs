/**
 * F1.11 — Kabul yürütücüleri için deterministik test verisi üreticileri.
 *
 * Üretilen her dosya staging tarama servisinin (services/content-scan) tür ve
 * ayrıştırıcı doğrulamasını geçecek biçimde gerçek, geçerli bir PDF'tir; kabul
 * kararının hangi kontrol tarafından verildiği böylece dışarıdan atfedilebilir.
 */

import { createHash } from "node:crypto";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * EICAR test imzası kaynak kodda ve kanıt dosyalarında asla bitişik geçmez:
 * geliştirici makinesindeki ya da CI koşucusundaki antivirüs bu depoyu
 * karantinaya almamalıdır. İmza yalnız çalışma anında, yüklenecek yükün
 * içinde birleştirilir.
 */
const EICAR_PARTS = ["X5O!P%@AP[4\\PZX54(P^)", "7CC)7}$EICAR-STANDARD-", "ANTIVIRUS-TEST-FILE!$H+H*"];

/** 68 baytlık standart EICAR imzasının bilinen SHA-256 özeti. */
export const EICAR_SHA256 = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f";

export function eicarSignature() {
  return EICAR_PARTS.join("");
}

/** Tohumlu xorshift32; sıkıştırılamaz, tekrarlanabilir dolgu üretir. */
export function pseudoRandomBytes(length, seed = 0x9e3779b9) {
  const bytes = new Uint8Array(length);
  let state = (seed >>> 0) || 1;
  for (let index = 0; index < length; index += 1) {
    state ^= (state << 13) >>> 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

const ascii = (text) => Buffer.from(text, "latin1");

/**
 * Asgari ama tam geçerli tek sayfalık PDF üretir (doğru xref ofsetleri,
 * trailer, startxref). `commentLine` başlıktan hemen sonra PDF yorumu olarak
 * eklenir; sözdizimsel olarak boşluktur, qpdf doğrulamasını etkilemez (K-2 bunu
 * EICAR imzasını taşımak için kullanır). `paddingBytes` sayfadan bağımsız bir
 * ikili stream nesnesi ekler; K-3 böylece multipart eşiğini aşan geçerli bir
 * PDF elde eder.
 */
export function buildPdfFixture({ text, commentLine = null, paddingBytes = 0, paddingSeed = 0x51ed270b } = {}) {
  const safeText = String(text ?? "kabul").replace(/[\\()]/g, "");
  const content = ascii(`BT /F1 12 Tf 72 720 Td (${safeText}) Tj ET`);
  const chunks = [];
  const offsets = new Map();
  let position = 0;
  const push = (chunk) => {
    chunks.push(chunk);
    position += chunk.length;
  };
  const beginObject = (number) => offsets.set(number, position);

  push(ascii("%PDF-1.4\n"));
  // İkili içerik işareti (ISO 32000 önerisi): 128 üzeri dört bayt.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  if (commentLine) push(ascii(`%${commentLine}\n`));

  beginObject(1);
  push(ascii("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  beginObject(2);
  push(ascii("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));
  beginObject(3);
  push(ascii("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
    + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n"));
  beginObject(4);
  push(ascii(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`));
  push(content);
  push(ascii("\nendstream\nendobj\n"));
  beginObject(5);
  push(ascii("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"));

  const objectCount = paddingBytes > 0 ? 6 : 5;
  if (paddingBytes > 0) {
    beginObject(6);
    push(ascii(`6 0 obj\n<< /Length ${paddingBytes} >>\nstream\n`));
    push(Buffer.from(pseudoRandomBytes(paddingBytes, paddingSeed)));
    push(ascii("\nendstream\nendobj\n"));
  }

  const xrefOffset = position;
  const entries = ["0000000000 65535 f \n"];
  for (let number = 1; number <= objectCount; number += 1) {
    entries.push(`${String(offsets.get(number)).padStart(10, "0")} 00000 n \n`);
  }
  push(ascii(`xref\n0 ${objectCount + 1}\n${entries.join("")}`));
  push(ascii(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}
