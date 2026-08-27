import assert from "node:assert/strict";
import test from "node:test";
import { contentDisposition } from "../lib/content-disposition.ts";

test("Türkçe dosya adı ASCII fallback ve RFC 5987 UTF-8 adıyla taşınır", () => {
  const header = contentDisposition("attachment", "2021  1 - 30 Meclis Kararı.pdf");

  assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.ok(!header.includes("ı"), "ham Unicode ASCII filename alanına girmemeli");
  assert.match(header, /Karar%C4%B1\.pdf$/);
});

test("başlık ayırıcıları ve denetim karakterleri dosya adına sızmaz", () => {
  const header = contentDisposition("inline", "kotu\r\nX-Test: evet\\\".pdf");

  assert.ok(!header.includes("\r"));
  assert.ok(!header.includes("\n"));
  assert.equal((header.match(/"/g) ?? []).length, 2);
  assert.match(header, /^inline; filename=/);
});
