/**
 * Kanıt kırpması matematiğinin güvenceleri.
 *
 * design.md §3.3 / §9.1 kararı: kırpma ayrı görsel üretmez, görüntüleme
 * türevinden CSS `background-position/size` ile anlık kesilir. Bu dosya o
 * hesabın sözleşmesini sabitler:
 *
 * - kanıt kutusu her zaman pencerenin İÇİNDE kalır (ilke 3: kanıt olmadan
 *   iddia yok — kırpma kutuyu kesip atarsa kanıt gösterilmemiş olur);
 * - pencere sayfa sınırlarını taşmaz, taşan istek sayfaya sıkıştırılır;
 * - kanıtı olmayan (sıfır/ters) kutu kırpma üretmez.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../server/ts-extension-hooks.mjs", import.meta.url);
const { evidenceCropStyle, hasEvidenceBox } = await import("../lib/evidence-crop.ts");

/** Yüzde metnini sayıya çevirir: "62.5% 10%" → [62.5, 10]. */
function percents(value: string): number[] {
  return value.split(" ").map((part) => Number(part.replace("%", "")));
}

/** Stilden kırpma penceresini geri hesaplar (sayfa piksel uzayında). */
function windowOf(style: { backgroundSize: string; backgroundPosition: string },
  pageWidth: number, pageHeight: number) {
  const [sizeX, sizeY] = percents(style.backgroundSize);
  const [posX, posY] = percents(style.backgroundPosition);
  const width = (pageWidth * 100) / sizeX;
  const height = (pageHeight * 100) / sizeY;
  return {
    left: ((pageWidth - width) * posX) / 100,
    top: ((pageHeight - height) * posY) / 100,
    width, height,
  };
}

test("kanıt kutusu üretilen pencerenin içinde kalır", () => {
  const box = [120, 400, 380, 440] as const; // tipik bir metin satırı
  const style = evidenceCropStyle(box, 1000, 1400);
  assert.ok(style, "geçerli kutu kırpma üretmeli");
  const view = windowOf(style, 1000, 1400);
  assert.ok(view.left <= box[0], "pencere kutunun solunu kesiyor");
  assert.ok(view.top <= box[1], "pencere kutunun üstünü kesiyor");
  assert.ok(view.left + view.width >= box[2], "pencere kutunun sağını kesiyor");
  assert.ok(view.top + view.height >= box[3], "pencere kutunun altını kesiyor");
  // En-boy oranı stilde pencereninkiyle aynı anlatılır; ikisi ayrışırsa görsel bozulur.
  const [aw, ah] = style.aspectRatio.split("/").map((part) => Number(part.trim()));
  assert.ok(Math.abs(aw / ah - view.width / view.height) < 0.01, "aspectRatio pencereden sapmış");
});

test("pencere sayfa sınırlarını taşmaz", () => {
  // Sayfanın en üst köşesindeki kutu: pencere yukarı taşamaz, 0'a dayanır.
  const style = evidenceCropStyle([2, 2, 300, 30] as const, 1000, 1400);
  assert.ok(style);
  const view = windowOf(style, 1000, 1400);
  assert.ok(view.left >= -0.01 && view.top >= -0.01, "pencere negatif konuma taştı");
  assert.ok(view.left + view.width <= 1000.01, "pencere sayfa genişliğini aştı");
  assert.ok(view.top + view.height <= 1400.01, "pencere sayfa yüksekliğini aştı");
});

test("pencere sayfadan geniş olamaz — küçük sayfada sayfaya kırpılır", () => {
  // 6:1 oran 200 genişlikte 1200 ister; sayfa 320x240'ta pencere sayfaya iner.
  const style = evidenceCropStyle([10, 100, 310, 140] as const, 320, 240);
  assert.ok(style);
  const view = windowOf(style, 320, 240);
  assert.ok(view.width <= 320.01 && view.height <= 240.01);
});

test("kanıtı olmayan kutu kırpma üretmez", () => {
  assert.equal(hasEvidenceBox([0, 0, 0, 0] as const), false);
  assert.equal(evidenceCropStyle([0, 0, 0, 0] as const, 1000, 1400), null);
  // Ters kutu (x1<x0) bozuk veridir; kırpma uydurulmaz.
  assert.equal(evidenceCropStyle([300, 100, 100, 200] as const, 1000, 1400), null);
  // Sayfa boyutu yoksa oran hesabı yapılamaz.
  assert.equal(evidenceCropStyle([10, 10, 50, 30] as const, 0, 0), null);
});
