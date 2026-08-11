import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runDerivativeIntegrity } from "../scripts/acceptance-executors/derivative-integrity.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "t03-evidence-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function ctx(dir) {
  return {
    runId: "run-0053",
    acceptanceToken: "a".repeat(32),
    config: { baseUrl: "https://staging.example", uploaderIdentity: "u@sivas.bel.tr", unit: "Yaz? ??leri" },
    signal: undefined,
    intervalMs: 0,
    derivativeTimeoutMs: 100,
    writeEvidence: evidenceWriter(dir),
  };
}

test("iki t?rev profili ?retilir, as?l envanteri de?i?mez ve do?ru s?n?flar sunulur", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({});
    const outcome = await runDerivativeIntegrity(client, ctx(dir));
    assert.equal(outcome.result, "PASS");
    assert.deepEqual(outcome.evidence.map((item) => item.kind).sort(), ["integrity", "inventory"]);
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["T-03-integrity.json", "T-03-inventory.json"]);
    const inventoryText = await readFile(join(dir, "T-03-inventory.json"), "utf8");
    const inventory = JSON.parse(inventoryText);
    assert.equal(inventory.originalUnchanged, true);
    assert.deepEqual(inventory.derivativeJobs.map((job) => job.profileVersion),
      ["access-pdf-v1", "access-pdf-v2"]);
    assert.ok(inventory.derivatives.every((object) =>
      object.derivedFromId === inventory.beforeOriginal.id));
    const integrityText = await readFile(join(dir, "T-03-integrity.json"), "utf8");
    const integrity = JSON.parse(integrityText);
    assert.equal(integrity.viewObjectClass, "access");
    assert.equal(integrity.downloadObjectClass, "original");
    assert.ok(!inventoryText.includes("T".repeat(43)) && !integrityText.includes("T".repeat(43)));
    const scopes = client.calls.filter((call) => call.path?.endsWith("/file"))
      .map((call) => call.headers["x-archive-access-scope"]);
    assert.deepEqual(scopes, ["VIEW", "DOWNLOAD"]);
  });
});

test("ikinci profil kuyru?a al?namazsa d?r?st?e FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const outcome = await runDerivativeIntegrity(fakeStaging({ derivativeEnqueueStatus: 503 }), ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T03_SECOND_PROFILE_ENQUEUE_FAILED");
  });
});

test("renderer k?ken kan?t? eksikse FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({
      evidenceTransform: (body, session) => session.secondDerivativeEnqueued ? {
        ...body,
        derivativeJobs: body.derivativeJobs.map((job, index) =>
          index === 1 ? { ...job, rendererImageDigest: null } : job),
      } : body,
    });
    const outcome = await runDerivativeIntegrity(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T03_RENDER_PROVENANCE_INVALID");
  });
});

test("t?rev ?retimi as?l?n depolama s?r?m?n? de?i?tirirse FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({
      evidenceTransform: (body, session) => session.secondDerivativeEnqueued ? {
        ...body,
        originalInventory: body.originalInventory.map((object) => ({
          ...object, storageVersionId: "mutated-version",
        })),
      } : body,
    });
    const outcome = await runDerivativeIntegrity(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T03_ORIGINAL_MUTATED");
  });
});

test("VIEW bileti as?l s?n?f?n? sunarsa FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const outcome = await runDerivativeIntegrity(fakeStaging({ viewObjectClass: "original" }), ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T03_VIEW_DERIVATIVE_INVALID");
  });
});

test("DOWNLOAD yeniden okumas? access s?n?f?ndan gelirse FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const outcome = await runDerivativeIntegrity(fakeStaging({ downloadObjectClass: "access" }), ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T03_ORIGINAL_REREAD_INVALID");
  });
});

test("renderer kontroll? profil y?kseltmesini istekteki s?r?me ba?lar", async () => {
  const source = await readFile(new URL("../services/document-render/app/main.py", import.meta.url), "utf8");
  assert.match(source, /profileVersion: str = Field\(pattern=r"\^access-pdf-v\[1-9\]\[0-9\]\*\$"\)/);
  assert.match(source, /assemble_segment\(pages\[start - 1:end\], segment_pdf, reference\.profileVersion\)/);
  assert.match(source, /"profileVersion": reference\.profileVersion/);
});
