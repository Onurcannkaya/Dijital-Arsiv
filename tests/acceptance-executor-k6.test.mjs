import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evidenceWriter } from "../scripts/acceptance-executors/contract.mjs";
import { runMaximumProfileConcurrency } from "../scripts/acceptance-executors/maximum-profile-concurrency.mjs";
import { fakeStaging } from "./acceptance-fake-staging.mjs";

test("K-6 ak?? ?reticisi b?t?n y?k? bellekte kurmadan e?zamanl? par?alar? ve metrikleri do?rular", async () => {
  const dir = await mkdtemp(join(tmpdir(), "k6-evidence-"));
  try {
    const client = fakeStaging({ partSize: 16, planFor: () => ({ poll: ["UPLOADING"] }) });
    const outcome = await runMaximumProfileConcurrency(client, {
      runId: "run-k6", requestCorrelationId: "run-k6-K-6",
      profileBytes: 64, sessionCount: 4, concurrentParts: 4, expectedPartBytes: 16,
      metricsAttempts: 1, metricsIntervalMs: 0, signal: undefined,
      config: {
        unit: "Kabul Testleri", resourceMetricsEndpoint: "https://metrics.example",
        resourceMetricsToken: "m".repeat(32),
        acceptanceProxyToken: "p".repeat(32),
        resourceMetricsFetcher: async (_url, init) => {
          assert.equal(init.headers["x-acceptance-proxy-token"], "p".repeat(32));
          return Response.json({
            source: "fake-worker-runtime", memoryLimitBytes: 128 * 1024 * 1024,
            samples: [20, 21, 20, 22, 21, 22, 21, 23].map((value) => ({
              memoryBytes: value * 1024 * 1024,
            })),
          });
        },
      },
      writeEvidence: evidenceWriter(dir),
    });
    assert.equal(outcome.result, "PASS");
    assert.equal(client.sessions.size, 4);
    assert.ok([...client.sessions.values()].every((session) => session.parts.size === 4));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
