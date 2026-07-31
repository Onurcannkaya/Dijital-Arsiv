/**
 * F1.11 — K-3 kesintili multipart yürütücüsü testleri.
 *
 * Kabul ölçütü (kanıt rehberi K-3): bozuk parça denemesi 422 ile reddedilir,
 * aynı idempotency anahtarıyla devralınan oturum doğrulanmış parçaları korur,
 * kalan parçalar tamamlanınca oturum ACCEPTED olur ve sunucu SHA'sı yerel
 * özetle eşleşir.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runMultipartResume } from "../scripts/acceptance-executors/multipart-resume.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "k3-evidence-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctx(dir, overrides = {}) {
  return {
    runId: "run-0031",
    config: { baseUrl: "https://staging.example", uploaderIdentity: "u@sivas.bel.tr", unit: "Yazı İşleri" },
    signal: undefined,
    intervalMs: 0,
    // Birim testi gerçek 33 MiB dolgu yerine küçük, çok parçalı bir yük kullanır.
    paddingBytes: 700,
    writeEvidence: evidenceWriter(dir),
    ...overrides,
  };
}

test("kesinti + devralma + tamamlanma: PASS ve SHA eşleşmesi", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ partSize: 512 });
    const outcome = await runMultipartResume(client, ctx(dir));
    assert.equal(outcome.result, "PASS");
    assert.equal(outcome.correlationId, "run-0031:K-3");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind).sort(), ["inventory", "multipart"]);

    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["K-3-inventory.json", "K-3-multipart.json"]);
    const multipart = JSON.parse(await readFile(join(dir, "K-3-multipart.json"), "utf8"));
    assert.equal(multipart.interruptedPartResponse.status, 422);
    assert.equal(multipart.interruptedPartResponse.code, "PART_CHECKSUM_MISMATCH");
    assert.equal(multipart.resume.resumed, true);
    assert.deepEqual(multipart.resume.completedParts, [1]);
    assert.ok(multipart.resume.missingParts.includes(2));
    assert.equal(multipart.finalStatus, "ACCEPTED");
    assert.ok(multipart.expectedPartCount >= 2);

    const inventory = JSON.parse(await readFile(join(dir, "K-3-inventory.json"), "utf8"));
    assert.equal(inventory.shaMatches, true);
    assert.equal(inventory.localSha256, inventory.serverSha256);

    // 2. parça iki kez denendi: önce bozuk (reddedildi), sonra doğru.
    const partTwoAttempts = client.calls.filter((call) => call.method === "PUT" && call.partNumber === 2);
    assert.equal(partTwoAttempts.length, 2);
  });
});

test("bozuk parça kabul edilirse FAIL: K3_CORRUPTION_NOT_DETECTED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ partSize: 512, verifyPartChecksum: false });
    const outcome = await runMultipartResume(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K3_CORRUPTION_NOT_DETECTED");
  });
});

test("devralmada parça envanteri kaybolursa FAIL: K3_RESUME_STATE_LOST", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({
      partSize: 512,
      onResume: (view) => ({ ...view, completedParts: [], missingParts: [1, ...view.missingParts] }),
    });
    const outcome = await runMultipartResume(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K3_RESUME_STATE_LOST");
  });
});

test("terminal ACCEPTED değilse FAIL: K3_TERMINAL_NOT_ACCEPTED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ partSize: 512, planFor: () => ({ poll: ["SCANNING", "REJECTED"] }) });
    const outcome = await runMultipartResume(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K3_TERMINAL_NOT_ACCEPTED");
  });
});

test("sunucu SHA'sı yerel özetle uyuşmazsa FAIL: K3_SHA_MISMATCH", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ partSize: 512, planFor: () => ({ reportSha: "0".repeat(64) }) });
    const outcome = await runMultipartResume(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K3_SHA_MISMATCH");
  });
});

test("oturum multipart değilse FAIL: K3_NOT_MULTIPART", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({});
    const outcome = await runMultipartResume(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K3_NOT_MULTIPART");
  });
});
