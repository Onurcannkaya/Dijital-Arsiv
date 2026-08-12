import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runConditionalWriteProtection } from "../scripts/acceptance-executors/conditional-write.mjs";
import { runOriginalIamSeparation } from "../scripts/acceptance-executors/original-iam-separation.mjs";
import { runQuarantineIamSeparation } from "../scripts/acceptance-executors/quarantine-iam-separation.mjs";
import { runPersonalDataSurfaceScan } from "../scripts/acceptance-executors/personal-data-scan.mjs";
import { runPostPromotionDbFailure } from "../scripts/acceptance-executors/post-promotion-db-failure.mjs";
import { runIntegrityMismatchDetection } from "../scripts/acceptance-executors/integrity-mismatch.mjs";
import { fakeS3, iamRoleCredentials, testCredentials } from "./acceptance-fake-s3.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "acceptance-wave3-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function baseCtx(dir, s3, extra = {}) {
  return {
    runId: "run-wave3",
    signal: undefined,
    intervalMs: 0,
    writeEvidence: evidenceWriter(dir),
    config: {
      baseUrl: "https://staging.example",
      uploaderIdentity: "uploader@sivas.bel.tr",
      acceptanceToken: "a".repeat(32),
      unit: "Kabul Testleri",
      s3: {
        endpoint: "https://s3.example",
        originalBucket: s3.originalBucket,
        quarantineBucket: s3.quarantineBucket,
        region: "auto",
        credentials: testCredentials("promotion"),
        fetcher: s3.fetcher,
      },
      iamRoles: iamRoleCredentials(),
      identities: {
        viewer: "viewer@sivas.bel.tr",
        unauthorized: "unauthorized@sivas.bel.tr",
      },
    },
    ...extra,
  };
}

test("T-01 ikinci ko?ullu yazmay? sa?lay?c? reddi ve de?i?meyen tam SHA ile kan?tlar", async () => {
  await withDir(async (dir) => {
    const s3 = fakeS3({});
    const outcome = await runConditionalWriteProtection(null, baseCtx(dir, s3));
    assert.equal(outcome.result, "PASS");
    const operation = JSON.parse(await readFile(join(dir, "T-01-operation.json"), "utf8"));
    const integrity = JSON.parse(await readFile(join(dir, "T-01-integrity.json"), "utf8"));
    assert.equal(operation.conflictingWrite.status, 412);
    assert.equal(operation.providerConditionalRejection, true);
    assert.equal(integrity.unchanged, true);
    assert.equal(JSON.stringify(operation).includes("secret-promotion"), false);
    assert.equal("key" in operation, false);
  });
});

test("T-06 OCR olumlu kontrol?yle d?rt fiziksel rol matrisini do?rular", async () => {
  await withDir(async (dir) => {
    const staging = fakeStaging({});
    const s3 = fakeS3({ staging });
    const ctx = baseCtx(dir, s3, {
      createAppClient: () => ({
        json: async () => ({ status: 403, ok: false, body: { code: "FORBIDDEN" } }),
      }),
    });
    const outcome = await runOriginalIamSeparation(staging, ctx);
    assert.equal(outcome.result, "PASS");
    const denial = JSON.parse(await readFile(join(dir, "T-06-access-denial.json"), "utf8"));
    assert.equal(denial.physicalRoleMatrix.ocr.get.status, 200);
    for (const role of ["viewer", "application", "scanner"]) {
      assert.equal(denial.physicalRoleMatrix[role].get.status, 403);
    }
    for (const role of ["viewer", "application", "scanner", "ocr"]) {
      assert.equal(denial.physicalRoleMatrix[role].put.status, 403);
      assert.equal(denial.physicalRoleMatrix[role].delete.status, 403);
    }
  });
});

test("K-4 scanner olumlu kontrol? yan?nda normal rollerin karantina okumas?n? reddeder", async () => {
  await withDir(async (dir) => {
    const staging = fakeStaging({
      planFor: (_key, name) => name.includes("-eicar.pdf")
        ? { poll: ["SCANNING", "REJECTED"] } : {},
    });
    const s3 = fakeS3({ staging });
    const outcome = await runQuarantineIamSeparation(staging, baseCtx(dir, s3));
    assert.equal(outcome.result, "PASS");
    const denial = JSON.parse(await readFile(join(dir, "K-4-access-denial.json"), "utf8"));
    assert.equal(denial.roleReads.scanner.result.status, 200);
    for (const role of ["viewer", "application", "ocr"]) {
      assert.equal(denial.roleReads[role].result.status, 403);
    }
    assert.equal(JSON.stringify(denial).includes("quarantine/sess-"), false);
  });
});
test("T-11 ham sentetik de?erleri kan?ta ta??madan ?? y?zeyi tarar", async () => {
  await withDir(async (dir) => {
    const staging = fakeStaging({ legacyKeyMigrations: { total: 3, byStatus: { COMPLETED: 3 } } });
    const s3 = fakeS3({ staging });
    const ctx = baseCtx(dir, s3, {
      requestCorrelationId: "run-wave3-T-11",
      logAttempts: 1,
      logIntervalMs: 0,
    });
    ctx.config.logEndpoint = "https://logs.example/query";
    ctx.config.logToken = "l".repeat(32);
    ctx.config.logFetcher = async (url, init) => {
      assert.equal(new URL(url).searchParams.get("correlationId"), "run-wave3-T-11");
      assert.match(init.headers.authorization, /^Bearer /);
      return Response.json({ records: [{
        correlationId: "run-wave3-T-11",
        event: "ingest.completed",
        documentId: "opaque-document-id",
        outcome: "success",
      }] });
    };
    const outcome = await runPersonalDataSurfaceScan(staging, ctx);
    assert.equal(outcome.result, "PASS");
    const scan = JSON.parse(await readFile(join(dir, "T-11-secret-scan.json"), "utf8"));
    const summary = JSON.parse(await readFile(join(dir, "T-11-finding-summary.json"), "utf8"));
    assert.equal(scan.surfaces.objectKey.findingCount, 0);
    assert.equal(scan.surfaces.customMetadata.findingCount, 0);
    assert.equal(scan.surfaces.correlatedLogs.findingCount, 0);
    assert.equal(summary.totalOpenFindings, 0);
    assert.equal(summary.legacyKeyMigrations.total, 3);
    assert.doesNotMatch(JSON.stringify({ scan, summary }),
      /Ahmet Yilmaz|Ataturk Mahallesi|10000000146|Ada 123 Parsel 45/);
  });
});

test("K-5 DB sonland?rma hatas?ndan kalan as?l? silmeden uzla?t?r?r", async () => {
  await withDir(async (dir) => {
    const staging = fakeStaging({});
    const s3 = fakeS3({ staging });
    const outcome = await runPostPromotionDbFailure(staging, baseCtx(dir, s3));
    assert.equal(outcome.result, "PASS");
    const fault = JSON.parse(await readFile(join(dir, "K-5-fault-injection.json"), "utf8"));
    const reconciliation = JSON.parse(await readFile(join(dir, "K-5-reconciliation.json"), "utf8"));
    assert.equal(fault.probeMode, "POST_PROMOTION_DB_FAILURE");
    assert.equal(reconciliation.orphanObjectStillPresent, true);
    assert.equal(reconciliation.orphanFinding.findingType, "ORPHAN_OBJECT");
    assert.equal(reconciliation.automaticDeletionObserved, false);
  });
});

test("T-08 tam-SHA bulgusunu, alarm ba??n? ve ge?ici hata ayr?m?n? kan?tlar", async () => {
  await withDir(async (dir) => {
    const staging = fakeStaging({});
    const s3 = fakeS3({ staging });
    const outcome = await runIntegrityMismatchDetection(staging, baseCtx(dir, s3));
    assert.equal(outcome.result, "PASS");
    const finding = JSON.parse(await readFile(join(dir, "T-08-finding.json"), "utf8"));
    const alarm = JSON.parse(await readFile(join(dir, "T-08-alarm.json"), "utf8"));
    assert.equal(finding.finding.findingType, "HASH_MISMATCH");
    assert.equal(finding.transientProviderFailure.persistedFindingCount, 0);
    assert.equal(finding.originalAfterProbe.unchanged, true);
    assert.equal(alarm.correlationMatchesFinding, true);
    assert.equal(alarm.automaticRepairObserved, false);
  });
});

