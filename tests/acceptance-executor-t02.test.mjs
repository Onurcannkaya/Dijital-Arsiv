/**
 * F1.11 — T-02 yazma sonrası SHA doğrulama yürütücüsü testleri.
 *
 * Kabul ölçütü (kanıt rehberi T-02): yerel SHA → karantina tam-akış SHA'sı →
 * belge kaydı SHA'sı → kasadan yeniden indirilen aslın SHA'sı zinciri bayt-bayt
 * eşleşir; bilet açık metni kanıt dosyalarına yazılmaz.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runPostWriteShaVerification } from "../scripts/acceptance-executors/post-write-sha.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "t02-evidence-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctx(dir, overrides = {}) {
  return {
    runId: "run-0052",
    acceptanceToken: "a".repeat(32),
    config: { baseUrl: "https://staging.example", uploaderIdentity: "u@sivas.bel.tr", unit: "Yazı İşleri" },
    signal: undefined,
    intervalMs: 0,
    writeEvidence: evidenceWriter(dir),
    ...overrides,
  };
}

test("dört SHA değeri eşleşir: PASS, bilet kanıta sızmaz", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({});
    const outcome = await runPostWriteShaVerification(client, ctx(dir));
    assert.equal(outcome.result, "PASS");
    assert.equal(outcome.correlationId, "run-0052:T-02");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind).sort(), ["integrity", "receipt"]);

    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["T-02-integrity.json", "T-02-receipt.json"]);
    const receiptText = await readFile(join(dir, "T-02-receipt.json"), "utf8");
    const integrityText = await readFile(join(dir, "T-02-integrity.json"), "utf8");
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.localSha256, receipt.quarantineSha256);
    assert.equal(receipt.localSha256, receipt.documentSha256);
    assert.equal(receipt.finalStatus, "ACCEPTED");
    const integrity = JSON.parse(integrityText);
    assert.equal(integrity.shaMatches, true);
    assert.equal(integrity.downloadedSha256, receipt.localSha256);

    // İndirme DOWNLOAD kapsamı ve ArchiveTicket başlığıyla yapıldı; bilet kanıta yazılmadı.
    const download = client.calls.find((call) => call.path?.endsWith("/file"));
    assert.match(download.headers.authorization, /^ArchiveTicket /);
    assert.equal(download.headers["x-archive-access-scope"], "DOWNLOAD");
    const ticketToken = "T".repeat(43);
    assert.ok(!receiptText.includes(ticketToken) && !integrityText.includes(ticketToken));
  });
});

test("indirilen asıl farklı hash'lenirse FAIL: T02_VAULT_SHA_MISMATCH", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ corruptDownload: true });
    const outcome = await runPostWriteShaVerification(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T02_VAULT_SHA_MISMATCH");
    // Kanıt yine iki türü de kapsar; inceleyici uyuşmazlığı fiziksel dosyadan okur.
    const integrity = JSON.parse(await readFile(join(dir, "T-02-integrity.json"), "utf8"));
    assert.equal(integrity.shaMatches, false);
  });
});

test("karantina SHA'sı yerel özetle uyuşmazsa FAIL: T02_QUARANTINE_SHA_MISMATCH", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: () => ({ reportSha: "0".repeat(64) }) });
    const outcome = await runPostWriteShaVerification(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T02_QUARANTINE_SHA_MISMATCH");
  });
});

test("bilet verilmezse FAIL: T02_TICKET_DENIED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ ticketResponse: { status: 403, ok: false, body: { error: "yetki yok" } } });
    const outcome = await runPostWriteShaVerification(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T02_TICKET_DENIED");
  });
});

test("belge kaydı görünmezse FAIL: T02_DOCUMENT_NOT_FOUND", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ documentsStatus: 403 });
    const outcome = await runPostWriteShaVerification(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T02_DOCUMENT_NOT_FOUND");
  });
});

test("yükleme kabul edilmezse FAIL: T02_UPLOAD_NOT_ACCEPTED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: () => ({ poll: ["SCANNING", "REJECTED"] }) });
    const outcome = await runPostWriteShaVerification(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T02_UPLOAD_NOT_ACCEPTED");
  });
});

test("terfi kan?t?ndaki belge/as?l/OCR say?mlar? eksikse FAIL", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({
      evidenceTransform: (body) => ({
        ...body,
        counts: { ...body.counts, originalObjects: 0 },
      }),
    });
    const outcome = await runPostWriteShaVerification(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T02_ARTIFACT_COUNTS_INVALID");
  });
});
