/**
 * F1.11 — K-1 MIME/magic-byte uyuşmazlığı yürütücüsü testleri.
 *
 * Yürütücü gerçek staging'e HTTP ile bağlanır; burada sahte istemci ve geçici
 * kanıt dizini kullanılır. Kabul ölçütü (kanıt rehberi K-1): tür-red edilen
 * yükleme REJECTED terminaline ulaşır, asıl/OCR üretmez.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { executors, runMimeMismatch } from "../scripts/acceptance-executors/pipeline.mjs";

/** İstenen yol sırasına göre yanıt döndüren, çağrıları kaydeden sahte istemci. */
function fakeClient(plan) {
  const calls = [];
  return {
    calls,
    async json(method, path, options) {
      calls.push({ method, path });
      if (method === "POST" && path === "/api/uploads") return plan.create;
      if (method === "POST" && path.endsWith("/complete")) return plan.complete;
      if (method === "GET" && path.startsWith("/api/uploads?id=")) {
        return plan.poll.shift() ?? plan.poll[plan.poll.length - 1];
      }
      throw new Error(`beklenmeyen json çağrısı: ${method} ${path}`);
    },
    async putPart(path) {
      calls.push({ method: "PUT", path });
      return plan.part;
    },
  };
}

async function withEvidenceDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "k1-evidence-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctx(dir, overrides = {}) {
  return {
    runId: "run-0007",
    config: { baseUrl: "https://staging.example", uploaderIdentity: "u@sivas.bel.tr", unit: "Yazı İşleri" },
    signal: undefined,
    writeEvidence: evidenceWriter(dir),
    ...overrides,
  };
}

const ok = (session) => ({ status: 200, ok: true, body: { session } });

test("magic-byte uyuşmazlığı REJECTED ile sonuçlanır: PASS ve iki kanıt", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeClient({
      create: { status: 201, ok: true, body: { session: { id: "sess-1", status: "UPLOADING" } } },
      part: { status: 200, ok: true, body: { session: { status: "UPLOADING" } } },
      complete: ok({ status: "QUARANTINED" }),
      poll: [ok({ status: "SCANNING" }), ok({ status: "REJECTED" })],
    });
    const outcome = await runMimeMismatch(client, ctx(dir, { intervalMs: 0 }));
    assert.equal(outcome.result, "PASS");
    assert.equal(outcome.correlationId, "run-0007:K-1");
    assert.deepEqual(outcome.evidence.map((entry) => entry.kind).sort(), ["absence", "validation"]);

    // Kanıt dosyaları gerçekten yazıldı ve REJECTED sonucunu taşıyor; sır yok.
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ["K-1-absence.json", "K-1-validation.json"]);
    const validation = JSON.parse(await readFile(join(dir, "K-1-validation.json"), "utf8"));
    assert.equal(validation.finalStatus, "REJECTED");
    assert.equal(validation.declaredMediaType, "application/pdf");
    assert.equal(validation.payloadMagic, "MZ");
    assert.match(validation.sha256, /^[a-f0-9]{64}$/);
    const absence = JSON.parse(await readFile(join(dir, "K-1-absence.json"), "utf8"));
    assert.equal(absence.reachedAccepted, false);
  });
});

test("tür reddi uygulanmaz (ACCEPTED) ise FAIL ve açık hata kodu", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeClient({
      create: { status: 201, ok: true, body: { session: { id: "sess-2", status: "UPLOADING" } } },
      part: { status: 200, ok: true, body: { session: { status: "UPLOADING" } } },
      complete: ok({ status: "QUARANTINED" }),
      poll: [ok({ status: "SCANNING" }), ok({ status: "VERIFIED" }), ok({ status: "ACCEPTED" })],
    });
    const outcome = await runMimeMismatch(client, ctx(dir, { intervalMs: 0 }));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K1_TYPE_MISMATCH_NOT_ENFORCED");
    assert.equal(outcome.evidence.length, 2);
  });
});

test("oturum açılamazsa FAIL ve kanıt üretilir", async () => {
  await withEvidenceDir(async (dir) => {
    const client = fakeClient({
      create: { status: 403, ok: false, body: { error: "yetki yok", code: "FORBIDDEN" } },
      part: { status: 200, ok: true, body: {} },
      complete: ok({ status: "QUARANTINED" }),
      poll: [ok({ status: "REJECTED" })],
    });
    const outcome = await runMimeMismatch(client, ctx(dir));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K1_SESSION_NOT_CREATED");
    // Sadece POST /api/uploads denendi; parça/tamamlama çağrılmadı.
    assert.deepEqual(client.calls.map((call) => call.path), ["/api/uploads"]);
  });
});

test("terminale ulaşmadan süre dolarsa FAIL: K1_INCONCLUSIVE_TIMEOUT", async () => {
  await withEvidenceDir(async (dir) => {
    let clock = 0;
    const client = fakeClient({
      create: { status: 201, ok: true, body: { session: { id: "sess-3", status: "UPLOADING" } } },
      part: { status: 200, ok: true, body: {} },
      complete: ok({ status: "QUARANTINED" }),
      poll: [ok({ status: "SCANNING" })],
    });
    const outcome = await runMimeMismatch(client, ctx(dir, {
      intervalMs: 0, timeoutMs: 10, now: () => (clock += 20),
    }));
    assert.equal(outcome.result, "FAIL");
    assert.equal(outcome.errorCode, "K1_INCONCLUSIVE_TIMEOUT");
  });
});

test("modül K-1 yürütücüsünü sözleşme imzasıyla dışa aktarır", () => {
  assert.equal(typeof executors["K-1"], "function");
});
