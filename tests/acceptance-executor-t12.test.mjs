import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runBidirectionalReconciliation } from "../scripts/acceptance-executors/bidirectional-reconciliation.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "t12-evidence-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function ctx(dir) {
  return {
    runId: "run-0062",
    acceptanceToken: "a".repeat(32),
    config: { baseUrl: "https://staging.example", uploaderIdentity: "u@sivas.bel.tr", unit: "Kabul Testleri" },
    signal: undefined,
    intervalMs: 0,
    writeEvidence: evidenceWriter(dir),
  };
}

test("iki y?nl? uzla?t?rma iki kal?c? bulguyu ve gen? nesne tolerans?n? kan?tlar", async () => {
  await withEvidenceDir(async (dir) => {
    const outcome = await runBidirectionalReconciliation(fakeStaging({}), ctx(dir));
    assert.equal(outcome.result, "PASS");
    const reconciliation = JSON.parse(await readFile(join(dir, "T-12-reconciliation.json"), "utf8"));
    const finding = JSON.parse(await readFile(join(dir, "T-12-finding.json"), "utf8"));
    assert.equal(reconciliation.run.status, "COMPLETED");
    assert.equal(reconciliation.youngObjectToleranceApplied, true);
    assert.deepEqual(finding.findings.map((entry) => entry.findingType).sort(),
      ["MISSING_OBJECT", "ORPHAN_OBJECT"]);
    assert.equal(finding.orphanObjectStillPresent, true);
    assert.doesNotMatch(JSON.stringify(finding), /acceptance\/reconciliation\//);
  });
});

test("probe ucu ba?ar?s?zsa FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const outcome = await runBidirectionalReconciliation(
      fakeStaging({ reconciliationProbeStatus: 503 }), ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T12_RECONCILIATION_PROBE_FAILED");
  });
});

test("gen? kontrol yanl?? alarm ?retirse FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const base = fakeStaging({});
    const originalJson = base.json.bind(base);
    base.json = async (method, path, request) => {
      const response = await originalJson(method, path, request);
      if (request?.body?.action === "RUN_RECONCILIATION_PROBE" && response.ok) {
        response.body.expectations.youngControlFindingCount = 1;
      }
      return response;
    };
    const outcome = await runBidirectionalReconciliation(base, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T12_RECONCILIATION_EVIDENCE_INVALID");
  });
});

test("sahipsiz nesne otomatik silinirse FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const response = {
      run: { id: "run", status: "COMPLETED", binarySnapshotMaxRowid: 1,
        documentSnapshotMaxRowid: 1, checkedCount: 2, findingCount: 2 },
      findings: [
        { id: "f1", recordKind: "STORAGE_OBJECT", recordId: null, objectKeyDigest: "a".repeat(64), findingType: "ORPHAN_OBJECT", status: "OPEN" },
        { id: "f2", recordKind: "BINARY_OBJECT", recordId: "recon-obj-test", objectKeyDigest: "b".repeat(64), findingType: "MISSING_OBJECT", status: "OPEN" },
      ],
      expectations: { orphanKeyDigest: "a".repeat(64), missingObjectId: "recon-obj-test",
        youngKeyDigest: "c".repeat(64), youngControlFindingCount: 0, orphanObjectStillPresent: false },
    };
    const outcome = await runBidirectionalReconciliation(
      fakeStaging({ reconciliationProbeResponse: response }), ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T12_RECONCILIATION_EVIDENCE_INVALID");
  });
});
