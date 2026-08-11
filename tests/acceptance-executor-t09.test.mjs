/**
 * F1.11 — T-09 yedekten geri yükleme tatbikatı yürütücüsü testleri.
 *
 * Kabul ölçütü (kanıt rehberi T-09): taşınabilir paket izole geri yükleme
 * kovasına aktarılır, her nesnenin SHA'sı manifestle eşleşir, belge uygulama
 * adaptöründen okunur ve toplam süre RTO hedefinin içindedir. Manifest özeti
 * koşucu tarafında yeniden hesaplanır; fiziksel anahtar kanıta yazılmaz.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../scripts/phase-one-acceptance-core.mjs";
import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runRestoreDrill } from "../scripts/acceptance-executors/restore-drill.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";
import { fakeS3, fakeTransferTarget, testCredentials } from "./acceptance-fake-s3.mjs";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "t09-evidence-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function harness({ stagingOptions = {}, restoreOptions = {} } = {}) {
  const staging = fakeStaging(stagingOptions);
  const source = fakeS3({ staging });
  const restore = fakeTransferTarget({ bucket: "restore-test", ...restoreOptions });
  const fetcher = (url, init) => {
    const bucket = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean)[0] ?? "");
    return bucket === restore.bucket ? restore.fetcher(url, init) : source.fetcher(url, init);
  };
  return { staging, source, restore, fetcher };
}

function ctx(dir, fetcher, overrides = {}) {
  return {
    runId: "run-0061",
    signal: undefined,
    intervalMs: 0,
    writeEvidence: evidenceWriter(dir),
    config: {
      baseUrl: "https://staging.example",
      uploaderIdentity: "uploader@sivas.bel.tr",
      acceptanceToken: "a".repeat(32),
      unit: "Kabul Testleri",
      restoreRtoSeconds: 900,
      s3: {
        endpoint: "https://s3.example",
        originalBucket: "original-test",
        quarantineBucket: "quarantine-test",
        restoreBucket: "restore-test",
        region: "auto",
        credentials: testCredentials("promotion"),
        fetcher,
      },
    },
    ...overrides,
  };
}

test("paket geri yükleme kovasına aktarılır ve dört katmanlı bütünlük: PASS", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, restore, fetcher } = harness();
    const outcome = await runRestoreDrill(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "PASS");
    assert.equal(outcome.correlationId, "run-0061:T-09");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind).sort(), ["integrity", "restore"]);

    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["T-09-integrity.json", "T-09-restore.json"]);
    const restoreText = await readFile(join(dir, "T-09-restore.json"), "utf8");
    const restoreEvidence = JSON.parse(restoreText);
    assert.equal(restoreEvidence.withinRto, true);
    assert.equal(restoreEvidence.rtoSeconds, 900);
    assert.equal(restoreEvidence.appReadback.shaMatches, true);
    assert.equal(restoreEvidence.documentContext.objectCount, 1);
    assert.ok(restoreEvidence.durationsMs.total >= 0);

    const integrity = JSON.parse(await readFile(join(dir, "T-09-integrity.json"), "utf8"));
    assert.equal(integrity.digestRecomputedByRunner, true);
    assert.equal(integrity.restoredManifestShaMatches, true);
    assert.equal(integrity.allObjectsRestored, true);
    assert.deepEqual(integrity.objects.map((object) => object.shaMatches), [true]);

    // Paket fiziksel olarak geri yükleme kovasında: manifest + nesne.
    const keys = [...restore.store.keys()];
    assert.equal(keys.filter((key) => key.endsWith("/manifest.json")).length, 1);
    assert.equal(keys.filter((key) => key.includes("/objects/")).length, 1);
    // Kaynak asıl nesnenin fiziksel anahtarı kanıta yazılmaz.
    const session = [...staging.sessions.values()][0];
    assert.ok(!restoreText.includes(`original/${session.id}`));
  });
});

test("manifest özeti uyuşmazsa FAIL: T09_MANIFEST_DIGEST_MISMATCH", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({
      stagingOptions: {
        portableManifestTransform: (response) => ({ ...response, manifestDigest: "0".repeat(64) }),
      },
    });
    const outcome = await runRestoreDrill(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T09_MANIFEST_DIGEST_MISMATCH");
  });
});

test("kaynak nesne manifest kanıtıyla uyuşmazsa FAIL: T09_SOURCE_OBJECT_MISMATCH", async () => {
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
            objectLocators: [{ ...response.objectLocators[0], sha256: "0".repeat(64) }],
          };
        },
      },
    });
    const outcome = await runRestoreDrill(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T09_SOURCE_OBJECT_MISMATCH");
  });
});

test("geri yükleme kovası yazılamazsa FAIL: T09_RESTORE_WRITE_FAILED", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({ restoreOptions: { denyWrites: true } });
    const outcome = await runRestoreDrill(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T09_RESTORE_WRITE_FAILED");
  });
});

test("geri yüklenen nesne bozuk okunursa FAIL: T09_RESTORE_OBJECT_MISMATCH", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness({ restoreOptions: { corruptReads: true } });
    const outcome = await runRestoreDrill(staging, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T09_RESTORE_OBJECT_MISMATCH");
  });
});

test("RTO hedefi aşılırsa FAIL: T09_RTO_EXCEEDED", async () => {
  await withEvidenceDir(async (dir) => {
    // Tamamlanma senkron terminaldir ki sahte saat yoklama zaman aşımı üretmesin;
    // saat her okumada 30 dakika ilerler ve 60 saniyelik RTO hedefini aşar.
    const { staging, fetcher } = harness({
      stagingOptions: { planFor: () => ({ completeStatus: "ACCEPTED" }) },
    });
    let tick = 0;
    const context = ctx(dir, fetcher, { now: () => (tick += 30 * 60 * 1000) });
    context.config = { ...context.config, restoreRtoSeconds: 60 };
    const outcome = await runRestoreDrill(staging, context);
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T09_RTO_EXCEEDED");
    const restoreEvidence = JSON.parse(await readFile(join(dir, "T-09-restore.json"), "utf8"));
    assert.equal(restoreEvidence.withinRto, false);
  });
});

test("belge uygulama adaptörüyle okunamazsa FAIL: T09_APP_READBACK_FAILED", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness();
    const client = {
      ...staging,
      async json(method, path, request) {
        if (method === "GET" && /^\/api\/documents\/doc-/.test(path)) {
          return { status: 503, ok: false, body: null };
        }
        return staging.json(method, path, request);
      },
    };
    const outcome = await runRestoreDrill(client, ctx(dir, fetcher));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T09_APP_READBACK_FAILED");
  });
});

test("kabul jetonu yoksa FAIL: T09_ACCEPTANCE_TOKEN_MISSING", async () => {
  await withEvidenceDir(async (dir) => {
    const { staging, fetcher } = harness();
    const context = ctx(dir, fetcher);
    context.config = { ...context.config, acceptanceToken: undefined };
    const outcome = await runRestoreDrill(staging, context);
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T09_ACCEPTANCE_TOKEN_MISSING");
  });
});
