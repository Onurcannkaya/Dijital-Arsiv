import assert from "node:assert/strict";
import test from "node:test";

import {
  findHighlightRanges, foldWithMap, matchesAnyToken, matchSnippets, searchTokens,
} from "../lib/search-highlight.ts";
import { normalizeSearch } from "../lib/text-search.ts";

test("katlama, arama dizininin biçimini karakter haritasıyla üretir", () => {
  /*
   * Vurgunun doğruluğu bu eşitliğe dayanır: katlanmış metin, dizindeki
   * `search_text` ile aynı biçimde olmalı ki sunucuda eşleşen sorgu ekranda
   * da bulunsun. Tek bilinçli fark mekanik OCR karışıklık düzeltmeleridir
   * (dosya başındaki gerekçe); bu örneklerde o kurallar tetiklenmez.
   */
  for (const sample of [
    "Ali KESKİN'in dilekçesi",
    "Emlak ve İstimlak Müdürlüğünden verilen 4315 sayılı yazı",
    "Çayboyu Mahallesi 311 ada, 28 parsel — şüyulandırma",
    "  Boşluklu   ve NOKTALI... metin  ",
  ]) {
    assert.equal(foldWithMap(sample).text, normalizeSearch(sample), sample);
  }
});

test("vurgu aralığı özgün metindeki büyük harfli ve diakritikli kelimeyi bulur", () => {
  const display = "Muhatap Ali KESKİN'in 311 ada hakkındaki dilekçesi";
  const ranges = findHighlightRanges(display, searchTokens("ali keskin"));
  assert.equal(ranges.length, 2);
  assert.equal(display.slice(ranges[0][0], ranges[0][1]), "Ali");
  assert.equal(display.slice(ranges[1][0], ranges[1][1]), "KESKİN");
});

test("üst üste binen aralıklar tek işarete kaynaşır", () => {
  // "keskin" ve "eski" aynı kelimede kesişir; iç içe <mark> üretilmemeli.
  const display = "Ali Keskin dosyası";
  const ranges = findHighlightRanges(display, [...searchTokens("keskin"), ...searchTokens("eski")]);
  assert.equal(ranges.length, 1);
  assert.equal(display.slice(ranges[0][0], ranges[0][1]), "Keskin");
});

test("sayfa eşleşmesi tam normalleştirmeyle karar verir", () => {
  const tokens = searchTokens("müdürlüğünden");
  assert.ok(matchesAnyToken("Emlak ve İstimlak MÜDÜRLÜĞÜNDEN verilen yazı", tokens));
  assert.ok(!matchesAnyToken("Encümen kararı", tokens));
  assert.ok(!matchesAnyToken("", tokens));
});

test("kırpıntı, eşleşmeyi bağlamıyla verir ve pencere başına toplar", () => {
  const once = "a".repeat(200);
  const display = `${once} Ali Keskin dilekçe verdi ${"b".repeat(200)} Ali Keskin tekrar geldi`;
  const ranges = findHighlightRanges(display, searchTokens("keskin"));
  const snippets = matchSnippets(display, ranges, 3, 30);
  assert.equal(snippets.length, 2, "uzak eşleşmeler ayrı kırpıntı olmalı");
  assert.ok(snippets[0].text.includes("Keskin"));
  assert.ok(snippets[0].leading, "metnin ortasından kırpıldığı belli olmalı");
  // Kırpıntının kendi aralıkları kendi metnine göredir.
  const [start, end] = snippets[0].ranges[0];
  assert.equal(snippets[0].text.slice(start, end), "Keskin");
});

test("anahtarlı süzgeç parçaları vurgu üretmez, serbest metin üretir", () => {
  // `ada:32` hedefli süzgeçtir; sayfada geçen her '32' işaretlenirse gürültü olur.
  assert.deepEqual(searchTokens("ali keskin"), ["ali", "keskin"]);
  assert.equal(findHighlightRanges("32 ada 5 parsel", searchTokens("")).length, 0);
});

test("inceleme ekranı arama terimini alır ve eşleşmeye kendiliğinden gider", async () => {
  /*
   * Kaynak kilidi: bu bağlantı koparsa arama yine belge bulur ama açılan
   * ekranda hiçbir şey işaretlenmez — özellik sessizce ölür ve ancak memur
   * şikayetiyle fark edilir. Kilit tam bu sessiz kopuşu yakalar.
   */
  const { readFile } = await import("node:fs/promises");
  const workspace = await readFile(new URL("../app/archive/workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /searchTerm=\{searching\?query\.trim\(\):""\}/,
    "workspace arama terimini inceleme ekranına taşımıyor");
  const review = await readFile(new URL("../app/archive/document-review.tsx", import.meta.url), "utf8");
  // Sorgu, sunucuyla aynı ayrıştırmadan geçer: anahtarlı süzgeç vurgulanmaz.
  assert.match(review, /parseQuickQuery\(searchTerm\?\?""\)\.freeText/);
  // Aramadan gelen memur ilk eşleşmeye kendisi tıklamak zorunda kalmaz.
  assert.match(review, /jumpToPage\(matchingPages\[0\]\)/);
  // Sayfa bölümleri atlanabilir çapa taşır.
  assert.match(review, /id=\{`okuma-sayfa-\$\{page\.pageNumber\}`\}/);
});
