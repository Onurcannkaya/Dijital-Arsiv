/**
 * Mobil tarama kalite denetiminin güvenceleri (design.md §4.4).
 *
 * Denetim yönlendirir, ENGELLEMEZ: uyarılar eylem cümlesidir (§6 — sayı yok)
 * ve eşikler bilinçli hoşgörülüdür; yanlış pozitif uyarı memuru uyarıları
 * toptan yok saymaya alıştırır.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { assessScanQuality } = await import("../lib/scan-quality.ts");

test("iyi fotoğraf uyarı üretmez", () => {
  assert.deepEqual(assessScanQuality({ width: 3000, height: 4000, meanLuminance: 180 }), []);
  // Eşik sınırları dahil değildir: tam sınırdaki değer temizdir.
  assert.deepEqual(assessScanQuality({ width: 900, height: 1200, meanLuminance: 70 }), []);
});

test("düşük çözünürlük, karanlık ve parlama ayrı ayrı adlandırılır", () => {
  const codes = (metrics: Parameters<typeof assessScanQuality>[0]) =>
    assessScanQuality(metrics).map((warning) => warning.code);
  assert.deepEqual(codes({ width: 640, height: 480, meanLuminance: 160 }), ["LOW_RESOLUTION"]);
  assert.deepEqual(codes({ width: 2000, height: 1500, meanLuminance: 40 }), ["TOO_DARK"]);
  assert.deepEqual(codes({ width: 2000, height: 1500, meanLuminance: 252 }), ["TOO_BRIGHT"]);
  // Bembeyaz zeminli seyrek metinli sayfa ~245 ortalamaya MEŞRU çıkar; uyarı almaz.
  assert.deepEqual(codes({ width: 2000, height: 1500, meanLuminance: 245 }), []);
  // Birden çok sorun birlikte bildirilir; ilki ikincisini yutmaz.
  assert.deepEqual(codes({ width: 640, height: 480, meanLuminance: 40 }), ["LOW_RESOLUTION", "TOO_DARK"]);
});

test("uyarı dili eylem cümlesidir: yeniden çekmeye yönlendirir, sayı içermez", () => {
  const all = [
    ...assessScanQuality({ width: 640, height: 480, meanLuminance: 40 }),
    ...assessScanQuality({ width: 2000, height: 1500, meanLuminance: 252 }),
  ];
  for (const warning of all) {
    assert.match(warning.message, /yeniden çekin/, warning.code);
    assert.doesNotMatch(warning.message, /\d/, `${warning.code} ölçüm sızdırıyor`);
  }
});

test("ölçülemeyen fotoğraf uydurma uyarı almaz", () => {
  // Boyut/parlaklık okunamadıysa (0), yokluğu sorun gibi bildirmek yanıltır.
  assert.deepEqual(assessScanQuality({ width: 0, height: 0, meanLuminance: 0 }), []);
});
