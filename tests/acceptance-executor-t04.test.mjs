import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runNoStorageKeyDisclosure } from "../scripts/acceptance-executors/no-storage-key-disclosure.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "t04-evidence-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctx(dir) {
  return {
    runId: "run-0054",
    config: {
      baseUrl: "https://staging.example",
      uploaderIdentity: "u@sivas.bel.tr",
      unit: "Yaz? ??leri",
    },
    intervalMs: 0,
    writeEvidence: evidenceWriter(dir),
  };
}

test("normal kullan?c? yan?tlar?nda depolama konumu yoktur ve do?rudan dosya reddedilir", async () => {
  await withEvidenceDir(async (dir) => {
    const outcome = await runNoStorageKeyDisclosure(
      fakeStaging({ requireFileCredential: true }),
      ctx(dir),
    );
    assert.equal(outcome.result, "PASS");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind).sort(),
      ["access-denial", "secret-scan"]);
  });
});

test("liste yan?t?nda storage_key benzeri alan g?r?l?rse FAIL", async () => {
  await withEvidenceDir(async (dir) => {
    const outcome = await runNoStorageKeyDisclosure(fakeStaging({
      requireFileCredential: true,
      ticketResponse: { status: 201, ok: true, body: { ticket: "T".repeat(43), storage_key: "forbidden" } },
    }), ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T04_STORAGE_KEY_DISCLOSED");
  });
});

test("biletsiz do?rudan dosya eri?imi a??l?rsa FAIL", async () => {
  await withEvidenceDir(async (dir) => {
    const outcome = await runNoStorageKeyDisclosure(fakeStaging({}), ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T04_DIRECT_ACCESS_NOT_DENIED");
  });
});

test("belge detay rotas? depolama konumunu yan?t s?zle?mesine hi? almaz", async () => {
  const source = await readFile(new URL("../app/api/documents/[id]/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /object_key|storage_provider|objectKey|storageProvider/);
});
