import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runExpiredViewTicket } from "../scripts/acceptance-executors/expired-view-ticket.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "t05-evidence-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function harness(dir, options = {}) {
  let nowMs = Date.parse("2026-07-31T10:00:00.000Z");
  const now = () => nowMs;
  const client = fakeStaging({ enforceTickets: true, now, ...options });
  const context = {
    runId: "run-0055",
    acceptanceToken: "a".repeat(32),
    config: { baseUrl: "https://staging.example", uploaderIdentity: "u@sivas.bel.tr", unit: "Yaz? ??leri" },
    signal: undefined,
    intervalMs: 0,
    derivativeTimeoutMs: 100,
    now,
    wait: async (ms) => { nowMs += ms; },
    writeEvidence: evidenceWriter(dir),
  };
  return { client, context };
}

test("VIEW bileti ilk kullan?mda ?al???r; replay, s?re sonu ve belge ta??ma reddedilir", async () => {
  await withEvidenceDir(async (dir) => {
    const { client, context } = harness(dir);
    const outcome = await runExpiredViewTicket(client, context);
    assert.equal(outcome.result, "PASS");
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["T-05-access-denial.json", "T-05-audit.json"]);
    const denialText = await readFile(join(dir, "T-05-access-denial.json"), "utf8");
    const denial = JSON.parse(denialText);
    assert.equal(denial.firstExchangeStatus, 200);
    assert.equal(denial.replayStatus, 403);
    assert.equal(denial.expiredStatus, 403);
    assert.equal(denial.crossDocumentStatus, 403);
    const audit = JSON.parse(await readFile(join(dir, "T-05-audit.json"), "utf8"));
    assert.equal(audit.counts.ticketDenials, 2);
    assert.equal(audit.counts.sessionDenials, 1);
    for (const call of client.calls.filter((entry) => entry.path?.endsWith("/file"))) {
      assert.ok(!denialText.includes(call.headers.authorization.split(" ")[1]));
    }
  });
});

test("t?ketilmi? bilet tekrar ?al???rsa FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const { client, context } = harness(dir, { allowTicketReplay: true });
    const outcome = await runExpiredViewTicket(client, context);
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T05_DENIAL_SEMANTICS_INVALID");
  });
});

test("s?resi dolmu? bilet ?al???rsa FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const { client, context } = harness(dir, { allowExpiredTickets: true });
    const outcome = await runExpiredViewTicket(client, context);
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T05_DENIAL_SEMANTICS_INVALID");
  });
});

test("g?r?nt?leme oturumu ba?ka belgeye ta??n?rsa FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const { client, context } = harness(dir, { allowCrossDocumentSession: true });
    const outcome = await runExpiredViewTicket(client, context);
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T05_DENIAL_SEMANTICS_INVALID");
  });
});

test("eri?im reddi denetim izi eksikse FAIL verir", async () => {
  await withEvidenceDir(async (dir) => {
    const { client, context } = harness(dir, {
      evidenceTransform: (body) => ({ ...body, accessAudit: [] }),
    });
    const outcome = await runExpiredViewTicket(client, context);
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "T05_AUDIT_TRAIL_INCOMPLETE");
  });
});
