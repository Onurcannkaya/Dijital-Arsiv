/**
 * F1.11 — K-7 mükerrer SHA yürütücüsü testleri.
 *
 * Kabul ölçütü (kanıt rehberi K-7): aynı içerik ikinci oturumda DUPLICATE
 * terminaline gider, ACCEPTED/PROMOTING görmez ve arşivde içerik için tek
 * belge kaydı kalır.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runDuplicateSha } from "../scripts/acceptance-executors/duplicate-sha.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "k7-evidence-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctx(dir, overrides = {}) {
  return {
    runId: "run-0047",
    config: { baseUrl: "https://staging.example", uploaderIdentity: "u@sivas.bel.tr", unit: "Yazı İşleri" },
    signal: undefined,
    intervalMs: 0,
    writeEvidence: evidenceWriter(dir),
    ...overrides,
  };
}

const acceptThenDuplicate = (key) => (key.endsWith("-a")
  ? { poll: ["SCANNING", "VERIFIED", "ACCEPTED"] }
  : { poll: ["SCANNING", "VERIFIED", "DUPLICATE"] });

test("ikinci oturum DUPLICATE ve arşivde tek belge: PASS", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: acceptThenDuplicate });
    const outcome = await runDuplicateSha(client, ctx(dir));
    assert.equal(outcome.result, "PASS");
    assert.equal(outcome.correlationId, "run-0047:K-7");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind).sort(), ["absence", "deduplication"]);

    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["K-7-absence.json", "K-7-deduplication.json"]);
    const deduplication = JSON.parse(await readFile(join(dir, "K-7-deduplication.json"), "utf8"));
    assert.equal(deduplication.first.finalStatus, "ACCEPTED");
    assert.equal(deduplication.second.finalStatus, "DUPLICATE");
    // Aynı bayt dizisi: iki akış aynı içerik SHA'sını taşır.
    assert.equal(deduplication.first.sha256, deduplication.second.sha256);
    assert.equal(deduplication.contentSha256, deduplication.first.sha256);

    const absence = JSON.parse(await readFile(join(dir, "K-7-absence.json"), "utf8"));
    assert.equal(absence.matchingDocuments.length, 1);
    assert.equal(absence.matchingDocuments[0].sha256, deduplication.contentSha256);
    assert.equal(absence.secondReachedAccepted, false);
    assert.equal(absence.secondReachedPromoting, false);
  });
});

test("ikinci oturum da ACCEPTED olursa FAIL: K7_DUPLICATE_NOT_DETECTED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: () => ({ poll: ["SCANNING", "VERIFIED", "ACCEPTED"] }) });
    const outcome = await runDuplicateSha(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K7_DUPLICATE_NOT_DETECTED");
  });
});

test("arşivde ikinci belge görünürse FAIL: K7_DOCUMENT_DUPLICATED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({
      planFor: acceptThenDuplicate,
      documentsTransform: (list) => (list.length
        ? [...list, { ...list[0], id: "doc-golge" }]
        : list),
    });
    const outcome = await runDuplicateSha(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K7_DOCUMENT_DUPLICATED");
  });
});

test("belge listesi okunamazsa FAIL: K7_DOCUMENT_LIST_UNAVAILABLE", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: acceptThenDuplicate, documentsStatus: 403 });
    const outcome = await runDuplicateSha(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K7_DOCUMENT_LIST_UNAVAILABLE");
  });
});

test("ilk yükleme kabul edilmezse FAIL: K7_FIRST_UPLOAD_NOT_ACCEPTED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: () => ({ poll: ["SCANNING", "REJECTED"] }) });
    const outcome = await runDuplicateSha(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K7_FIRST_UPLOAD_NOT_ACCEPTED");
    // İkinci akış hiç başlatılmadı: tek oturum açıldı.
    assert.equal(client.calls.filter((call) => call.method === "POST" && call.path === "/api/uploads").length, 1);
  });
});
