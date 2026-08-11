/**
 * F1.11 — Yürütücü test verisi üreticilerinin yapısal doğrulaması.
 *
 * Staging tarama servisi PDF'i magic-byte + qpdf ile doğrular; buradaki testler
 * üretilen dosyanın o sözleşmeye uyduğunu (başlık ofseti, xref tutarlılığı)
 * ve EICAR imzasının yalnız çalışma anında birleştiğini kanıtlar.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EICAR_SHA256,
  buildPdfFixture,
  eicarSignature,
  pseudoRandomBytes,
  sha256Hex,
} from "../scripts/acceptance-executors/fixtures.mjs";
import { executors } from "../scripts/acceptance-executors/pipeline.mjs";

test("PDF başlığı 0 ofsetinde ve dosya %%EOF ile biter", () => {
  const bytes = Buffer.from(buildPdfFixture({ text: "kabul-run-1" }));
  assert.equal(bytes.subarray(0, 9).toString("latin1"), "%PDF-1.4\n");
  assert.ok(bytes.subarray(-6).toString("latin1") === "%%EOF\n");
});

test("xref tablosundaki her ofset ilgili nesnenin başlangıcını gösterir", () => {
  const bytes = Buffer.from(buildPdfFixture({ text: "xref-dogrulama", paddingBytes: 512 }));
  const text = bytes.toString("latin1");
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
  const table = /xref\n0 (\d+)\n([\s\S]+?)trailer/.exec(text.slice(startxref));
  const count = Number(table[1]);
  const entries = table[2].split("\n").filter(Boolean);
  assert.equal(entries.length, count);
  entries.slice(1).forEach((entry, index) => {
    const offset = Number(entry.slice(0, 10));
    assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`);
  });
});

test("aynı girdi aynı baytları, farklı metin farklı özeti üretir", () => {
  const first = buildPdfFixture({ text: "ayni" });
  const second = buildPdfFixture({ text: "ayni" });
  const third = buildPdfFixture({ text: "farkli" });
  assert.equal(sha256Hex(first), sha256Hex(second));
  assert.notEqual(sha256Hex(first), sha256Hex(third));
});

test("dolgu istenen boyutta ikinci bir stream nesnesi ekler", () => {
  const plain = buildPdfFixture({ text: "dolgu" });
  const padded = buildPdfFixture({ text: "dolgu", paddingBytes: 4096 });
  assert.ok(padded.byteLength >= plain.byteLength + 4096);
  assert.ok(Buffer.from(padded).toString("latin1").includes("6 0 obj"));
  assert.ok(!Buffer.from(plain).toString("latin1").includes("6 0 obj"));
});

test("EICAR imzası çalışma anında birleşir ve bilinen SHA-256'yı verir", () => {
  const signature = eicarSignature();
  assert.equal(signature.length, 68);
  assert.equal(sha256Hex(Buffer.from(signature, "latin1")), EICAR_SHA256);
});

test("kaynak dosyalar bitişik EICAR imzası içermez", async () => {
  const signature = eicarSignature();
  for (const file of ["fixtures.mjs", "eicar-quarantine.mjs"]) {
    const source = await readFile(new URL(`../scripts/acceptance-executors/${file}`, import.meta.url), "utf8");
    assert.ok(!source.includes(signature), `${file} imzayı düz metin içeriyor`);
  }
});

test("yorum satırı imzayı PDF başlığını bozmadan taşır", () => {
  const bytes = Buffer.from(buildPdfFixture({ text: "eicar-tasima", commentLine: eicarSignature() }));
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(bytes.includes(Buffer.from(`%${eicarSignature()}\n`, "latin1")));
});

test("sözde rastgele dolgu deterministiktir", () => {
  assert.deepEqual(pseudoRandomBytes(64, 7), pseudoRandomBytes(64, 7));
  assert.notDeepEqual(pseudoRandomBytes(64, 7), pseudoRandomBytes(64, 8));
  assert.equal(pseudoRandomBytes(1234).length, 1234);
});

test("pipeline dikey dilimin beş yürütücüsünü dışa aktarır", () => {
  assert.deepEqual(Object.keys(executors).sort(), [
    "K-1", "K-2", "K-3", "K-4", "K-5", "K-6", "K-7",
    "T-01", "T-02", "T-03", "T-04", "T-05", "T-06", "T-07", "T-08", "T-11", "T-12",
  ]);
  for (const executor of Object.values(executors)) assert.equal(typeof executor, "function");
});
