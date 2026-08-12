/**
 * F1.11 — T-10 sağlayıcı taşınabilirlik yürütücüsü testleri.
 *
 * Kabul ölçütü (kanıt rehberi T-10): paket ikinci S3 uyumlu hedefe bağımsız
 * kimlikle aktarılır, bütün boyut/SHA-256 değerleri eksiksiz eşleşir ve
 * sağlayıcı ETag/sürüm kimliği bütünlük kararına girmez.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../scripts/phase-one-acceptance-core.mjs";
import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runProviderPortability } from "../scripts/acceptance-executors/portability.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";
import { fakeS3, fakeTransferTarget, testCredentials } from "./acceptance-fake-s3.mjs";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "t10-evidence-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function harness({ stagingOptions = {}, targetOptions = {} } = {}) {
  const staging = fakeStaging(stagingOptions);
  const source = fakeS3({ staging });
  const target = fakeTransferTarget({ bucket: "second-test", ...targetOptions });
  const fetcher = (url, init) => {
    const bucket = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[0] ?? "");
    return bucket === target.bucket ? target.fetcher(url, init) : source.fetcher(url, init);
  };
  return { staging, source, target, fetcher };
}

function ctx(dir, fetcher, overrides = {}) {
  return {
    runId: "run-0071",
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
        originalBucket: "original-test",
        quarantineBucket: "quarantine-test",
        region: "auto",
        credentials: testCredentials("promotion"),
        fetcher,
      },
      secondProvider: {
        endpoint: "https://second.example",
        bucket: "second-test",
        region: "auto",
        credentials: testCredentials("second-provider"),
        fetcher,
      },
    },
    ...overrides,
  };
}

test("paket ikinci adaptöre taşınır; karar yalnız içerik SHA'sıyla: PASS", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, target, fetcher } = harness();
    const outcome = await runProviderPortability(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "PASS");
    assert.equal(outcome.correlationId, "run-0071:T-10");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind).sort(), ["integrity", "portability"]);

    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["T-10-integrity.json", "T-10-portability.json"]);
    const portability = JSON.parse(await readFile(join(dir, "T-10-portability.json"), "utf8"));
    assert.equal(portability.sourceAdapterHost, "s3.example");
    assert.equal(portability.targetAdapterHost, "second.example");
    assert.equal(portability.objectCount, 1);
    // Hedef adaptör ETag'i bilinçli farklıdır; gözlemlenir ama karara girmez.
    assert.deepEqual(portability.transfers.map((transfer) => transfer.etagsEqual), [false]);

    const integrity = JSON.parse(await readFile(join(dir, "T-10-integrity.json"), "utf8"));
    assert.equal(integrity.decisionBasis, "content-sha256");
    assert.equal(integrity.providerEtagUsedForDecision, false);
    assert.equal(integrity.targetManifestShaMatches, true);
    assert.equal(integrity.allObjectsPortable, true);

    // Paket ikinci sağlayıcının deposunda fiziksel olarak mevcut.
    const keys = [...target.store.keys()];
    assert.equal(keys.filter((key) => key.endsWith("/manifest.json")).length, 1);
    assert.equal(keys.filter((key) => key.includes("/objects/")).length, 1);
  });
});

test("hedef yazma reddedilirse FAIL: T10_TARGET_WRITE_FAILED", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({ targetOptions: { denyWrites: true } });
    const outcome = await runProviderPortability(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T10_TARGET_WRITE_FAILED");
  });
});

test("hedeften bozuk okunan nesne FAIL: T10_TARGET_OBJECT_MISMATCH", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({ targetOptions: { corruptReads: true } });
    const outcome = await runProviderPortability(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T10_TARGET_OBJECT_MISMATCH");
    const integrity = JSON.parse(await readFile(join(dir, "T-10-integrity.json"), "utf8"));
    assert.equal(integrity.allObjectsPortable, false);
  });
});

test("desteklenmeyen kaynak ad alanı FAIL: T10_SOURCE_NAMESPACE_UNSUPPORTED", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({
      stagingOptions: {
        portableManifestTransform: (response) => ({
          ...response,
          objectLocators: [{ ...response.objectLocators[0], namespace: "DERIVATIVE_FILES" }],
        }),
      },
    });
    const outcome = await runProviderPortability(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T10_SOURCE_NAMESPACE_UNSUPPORTED");
  });
});

test("manifest dışa aktarılamazsa FAIL: T10_MANIFEST_EXPORT_FAILED", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({ stagingOptions: { manifestExportStatus: 503 } });
    const outcome = await runProviderPortability(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T10_MANIFEST_EXPORT_FAILED");
  });
});

test("manifest özeti uyuşmazsa FAIL: T10_MANIFEST_DIGEST_MISMATCH", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({
      stagingOptions: {
        portableManifestTransform: (response) => {
          // Manifest, özeti hesaplandıktan SONRA değiştirilmiş gibi döner.
          const manifest = { ...response.manifest, generatedAt: "2026-08-01T00:00:00.000Z" };
          return { ...response, manifest };
        },
      },
    });
    const outcome = await runProviderPortability(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T10_MANIFEST_DIGEST_MISMATCH");
  });
});

test("ikinci sağlayıcı yapılandırılmamışsa FAIL: T10_SECOND_PROVIDER_UNCONFIGURED", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness();
    const context = ctx(dir, fetcher);
    context.config = { ...context.config, secondProvider: undefined };
    const outcome = await runProviderPortability(staging, context);
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T10_SECOND_PROVIDER_UNCONFIGURED");
  });
});

test("fixture yüklemesi kabul edilmezse FAIL: T10_FIXTURE_UPLOAD_FAILED", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({
      stagingOptions: { planFor: () => ({ poll: ["SCANNING", "REJECTED"] }) },
    });
    const outcome = await runProviderPortability(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T10_FIXTURE_UPLOAD_FAILED");
  });
});

test("kaynak nesne SHA'sı uyuşmazsa FAIL: T10_SOURCE_OBJECT_MISMATCH", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({
      stagingOptions: {
        portableManifestTransform: (response) => {
          const manifest = {
            ...response.manifest,
            objects: [{ ...response.manifest.objects[0], sha256: "0".repeat(64) }],
          };
          return {
            ...response,
            manifest,
            manifestDigest: sha256Hex(Buffer.from(canonicalJson(manifest), "utf8")),
          };
        },
      },
    });
    const outcome = await runProviderPortability(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T10_SOURCE_OBJECT_MISMATCH");
  });
});
