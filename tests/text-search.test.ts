import assert from "node:assert/strict";
import test from "node:test";

import { escapeLike, normalizeSearch } from "../lib/text-search.ts";

/**
 * Arama normalleştirmesi davranış testleri.
 *
 * Kural artık tek yerde: dizin (`ocr_pages.search_text`) ve sorgu aynı
 * fonksiyondan geçer. Bu testler, önceki iki uygulamanın farkından doğan sessiz
 * eşleşme kayıplarının geri dönmemesini sağlar.
 */

test("Türkçe karakterler ve diyakritikler sadeleşir", () => {
  assert.equal(normalizeSearch("İMAR VE ŞEHİRCİLİK"), "imar ve sehircilik");
  assert.equal(normalizeSearch("Müdürlüğü"), "mudurlugu");
  assert.equal(normalizeSearch("Çağrı Özgür"), "cagri ozgur");
});

test("locale bağımsız küçültme kullanılır", () => {
  // Türkçe locale ile `"ISTANBUL"` → `"ıstanbul"` olur ve `"istanbul"` sorgusunu kaçırır.
  assert.equal(normalizeSearch("ISTANBUL"), "istanbul");
  assert.equal(normalizeSearch("İstanbul"), "istanbul");
});

test("eski taramalardaki mekanik OCR karışıklıkları düzeltilir", () => {
  // Python tarafındaki kuralların birebir karşılığı.
  assert.equal(normalizeSearch("Tapu Sici1 Müdürlüğü, 1580 sayılı yasa"), "tapu sicil mudurlugu 1580 sayili yasa");
  assert.equal(normalizeSearch("Sici1"), "sicil");
  assert.equal(normalizeSearch("i1e"), "iie");
  assert.equal(normalizeSearch("g0rulen"), "gorulen");
});

test("ada, parsel ve tarih gibi sayısal değerler bozulmaz", () => {
  assert.equal(normalizeSearch("Kandemir Mahallesi 32 ada 2 parsel"), "kandemir mahallesi 32 ada 2 parsel");
  assert.equal(normalizeSearch("11.09.1996"), "11 09 1996");
  assert.equal(normalizeSearch("1847"), "1847");
  // Yalnız harf bağlamındaki rakamlar düzeltilir; tek başına sayı korunur.
  assert.equal(normalizeSearch("1"), "1");
  assert.equal(normalizeSearch("10"), "10");
});

test("hukuki ekler ayrı belirteçlere dönüşür", () => {
  // `12/A` araması `12 a` olur; dizin de aynı biçimi üretir.
  assert.equal(normalizeSearch("12/A"), "12 a");
  assert.equal(normalizeSearch("3-B"), "3 b");
});

test("boş ve yalnız işaretli girdi boş dizeye iner", () => {
  assert.equal(normalizeSearch(""), "");
  assert.equal(normalizeSearch("   "), "");
  assert.equal(normalizeSearch("--- ,. ---"), "");
});

test("LIKE joker karakterleri kaçırılır", () => {
  assert.equal(escapeLike("%50"), "\\%50");
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("c\\d"), "c\\\\d");
  assert.equal(escapeLike("32 ada"), "32 ada");
});
