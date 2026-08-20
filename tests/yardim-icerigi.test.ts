/**
 * Yardım ve destek el kitabı.
 *
 * Yardım metni uygulamanın gerçek davranışını anlatmalıdır; gerçeklikten
 * kopmuş yardım, hiç olmamasından kötüdür. Bu denetim iki şeyi kilitler:
 * - kenar çubuğundaki giriş artık "Yakında" değil, gerçek ekrana bağlıdır;
 * - el kitabı çekirdek akışların TAMAMINI kapsar ve uygulamadaki gerçek
 *   etiketleri kullanır (durum adları, arama süzgeç sözdizimi, panel adları).
 *   Bir akışın adı değişirse bu test düşer ve yardım metni birlikte güncellenir.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("yardım girişi gerçek ekrana bağlıdır; 'Yakında' kalıntısı yoktur", async () => {
  const workspace = await read("app/archive/workspace.tsx");
  assert.match(workspace, /go\("help"\)/);
  assert.match(workspace, /<HelpScreen\/>/);
  assert.doesNotMatch(workspace, /Yakında/);
  assert.doesNotMatch(workspace, /henüz hazırlanmadı/);
});

test("el kitabı çekirdek akışları uygulamadaki gerçek adlarla anlatır", async () => {
  const help = await read("app/archive/help.tsx");
  // Yükleme: sihirbaz adımları, biçimler, tavan ve arka plan davranışı.
  for (const phrase of [
    "Belgeler → Yükleme ve okuma → Kontrol → Özet",
    "PDF, JPG, PNG, TIFF", "2 GiB", "Arka planda sürsün",
  ]) assert.ok(help.includes(phrase), `yükleme bölümü eksik: ${phrase}`);
  // Durum etiketleri arayüzle aynı dili kullanır.
  for (const label of [
    "Tarama bekliyor", "Mükerrer — bu belge zaten arşivde", "Süresi doldu; yeniden yükleyin",
    "OCR kuyruğunda", "Doğrulamaya hazır", "Arşivlendi",
  ]) assert.ok(help.includes(label), `durum etiketi eksik: ${label}`);
  // Doğrulama kuralları: ret gerekçesi, tam metin onayı, tasnif zorunluluğu.
  for (const phrase of ["Ret gerekçesizi olmaz", "Tam metin", "dosya planı ve saklama kuralı"])
    assert.ok(help.includes(phrase), `doğrulama bölümü eksik: ${phrase}`);
  // Arama sözdizimi gerçek süzgeç adlarıyla örneklenir.
  for (const filter of ["ada:", "parsel:", "mahalle:", "tur:", "yil:", "ref:"])
    assert.ok(help.includes(filter), `arama süzgeci eksik: ${filter}`);
  assert.ok(help.includes("Ctrl K"));
  // Sorun giderme panelleri ve destek yolu.
  for (const phrase of [
    "Bekleyen yüklemeler", "Kurtarma bekleyen yüklemeler", "Okuma arızaları",
    "Belgeyi okut", "olay kimliği", "Bilgi İşlem",
  ]) assert.ok(help.includes(phrase), `sorun giderme bölümü eksik: ${phrase}`);
});
