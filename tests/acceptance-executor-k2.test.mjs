/**
 * F1.11 — K-2 EICAR karantina yürütücüsü testleri.
 *
 * Kabul ölçütü (kanıt rehberi K-2): imzayı taşıyan geçerli PDF REJECTED
 * terminaline gider, içeriği eş ama imzasız kontrol PDF'i ACCEPTED olur; imza
 * ne kaynakta ne kanıtta düz metin geçer, yalnız yüklenen yükte bulunur.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { EICAR_SHA256, eicarSignature } from "../scripts/acceptance-executors/fixtures.mjs";
import { runEicarQuarantine } from "../scripts/acceptance-executors/eicar-quarantine.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "k2-evidence-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctx(dir, overrides = {}) {
  return {
    runId: "run-0021",
    config: { baseUrl: "https://staging.example", uploaderIdentity: "u@sivas.bel.tr", unit: "Yazı İşleri" },
    signal: undefined,
    intervalMs: 0,
    writeEvidence: evidenceWriter(dir),
    ...overrides,
  };
}

const rejectEicarAcceptControl = (key) => (key.endsWith("-eicar")
  ? { poll: ["SCANNING", "REJECTED"] }
  : { poll: ["SCANNING", "VERIFIED", "ACCEPTED"] });

test("EICAR REJECTED, kontrol ACCEPTED: PASS ve imza yalnız yüklenen yükte", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: rejectEicarAcceptControl });
    const outcome = await runEicarQuarantine(client, ctx(dir));
    assert.equal(outcome.result, "PASS");
    assert.equal(outcome.correlationId, "run-0021:K-2");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind).sort(), ["absence", "malware-scan"]);

    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["K-2-absence.json", "K-2-malware-scan.json"]);
    const scanText = await readFile(join(dir, "K-2-malware-scan.json"), "utf8");
    const absenceText = await readFile(join(dir, "K-2-absence.json"), "utf8");
    const scan = JSON.parse(scanText);
    assert.equal(scan.payload.embeddedSignatureSha256, EICAR_SHA256);
    assert.equal(scan.eicar.finalStatus, "REJECTED");
    assert.equal(scan.control.finalStatus, "ACCEPTED");
    assert.notEqual(scan.eicar.sha256, scan.control.sha256);
    // İmza kanıt dosyalarına sızmaz; yalnız yüklenen EICAR yükünde bulunur.
    const signature = Buffer.from(eicarSignature(), "latin1");
    assert.ok(!scanText.includes(eicarSignature()) && !absenceText.includes(eicarSignature()));
    const sessions = [...client.sessions.values()];
    const eicarSession = sessions.find((session) => session.name.endsWith("-eicar.pdf"));
    const controlSession = sessions.find((session) => session.name.endsWith("-control.pdf"));
    assert.ok(Buffer.from(eicarSession.payload).includes(signature));
    assert.ok(!Buffer.from(controlSession.payload).includes(signature));

    const absence = JSON.parse(absenceText);
    assert.equal(absence.reachedAccepted, false);
    assert.equal(absence.controlFinalStatus, "ACCEPTED");
  });
});

test("EICAR kabul edilirse FAIL: K2_MALWARE_NOT_BLOCKED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: () => ({ poll: ["SCANNING", "VERIFIED", "ACCEPTED"] }) });
    const outcome = await runEicarQuarantine(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K2_MALWARE_NOT_BLOCKED");
    assert.equal(outcome.evidence.length, 2);
  });
});

test("temiz kontrol kabul edilmezse sonuç atfedilemez: K2_CONTROL_NOT_ACCEPTED", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({ planFor: () => ({ poll: ["SCANNING", "REJECTED"] }) });
    const outcome = await runEicarQuarantine(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K2_CONTROL_NOT_ACCEPTED");
  });
});

test("oturum açılamazsa FAIL ve iki kanıt yine üretilir", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeStaging({
      planFor: (key) => (key.endsWith("-eicar")
        ? { create: { status: 403, ok: false, body: { error: "yetki yok", code: "FORBIDDEN" } } }
        : { poll: ["SCANNING", "VERIFIED", "ACCEPTED"] }),
    });
    const outcome = await runEicarQuarantine(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K2_UPLOAD_FLOW_FAILED");
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["K-2-absence.json", "K-2-malware-scan.json"]);
    const detail = JSON.parse(await readFile(join(dir, "K-2-malware-scan.json"), "utf8"));
    assert.equal(detail.eicar.failed.stage, "create");
    assert.equal(detail.eicar.failed.response.status, 403);
  });
});
