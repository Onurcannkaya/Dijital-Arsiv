import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../app/api/admin/acceptance-observability/route.ts";
import { setArchiveBindingsProvider } from "../lib/archive-bindings.ts";
import {
  configureAcceptanceObservability,
  logEvent,
  readRecentRuntimeMemorySamples,
  readRecentStructuredLogs,
  recordRuntimeMemorySample,
  resetAcceptanceObservabilityForTests,
} from "../lib/observability.ts";

const fakeDb = { prepare: () => ({}) } as unknown as D1Database;
const fakeBucket = { get: () => null } as unknown as R2Bucket;

test.afterEach(() => {
  resetAcceptanceObservabilityForTests();
  setArchiveBindingsProvider(null);
});

test("kabul gözlemlenebilirliği varsayılan ve kapalı durumda hiçbir kayıt tutmaz", () => {
  logEvent("info", "acceptance.test", { correlationId: "corr-disabled" });
  recordRuntimeMemorySample("corr-disabled", 1024);
  assert.deepEqual(readRecentStructuredLogs("corr-disabled"), []);
  assert.deepEqual(readRecentRuntimeMemorySamples("corr-disabled"), []);
});

test("açık staging halkası yalnız istenen korelasyonun sınırlı kopyasını döndürür", () => {
  configureAcceptanceObservability(true);
  logEvent("info", "acceptance.one", { correlationId: "corr-enabled", count: 1 });
  logEvent("warn", "acceptance.other", { correlationId: "corr-other", count: 2 });
  recordRuntimeMemorySample("corr-enabled", 2048);
  recordRuntimeMemorySample("geçersiz kimlik", 4096);

  const logs = readRecentStructuredLogs("corr-enabled", 10);
  const samples = readRecentRuntimeMemorySamples("corr-enabled");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "acceptance.one");
  assert.equal(logs[0].count, 1);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].memoryBytes, 2048);

  logs[0].event = "mutated";
  samples[0].memoryBytes = 0;
  assert.equal(readRecentStructuredLogs("corr-enabled")[0].event, "acceptance.one");
  assert.equal(readRecentRuntimeMemorySamples("corr-enabled")[0].memoryBytes, 2048);
});

test("kabul gözlemlenebilirlik ucu production'da gizli, staging'de jetonlu ve no-store çalışır", async () => {
  const token = "o".repeat(32);
  const request = (kind: string, authorization = `Bearer ${token}`) => new Request(
    `https://archive.example.test/api/admin/acceptance-observability?kind=${kind}&correlationId=corr-route`,
    { headers: { authorization } },
  );

  setArchiveBindingsProvider(() => ({
    DB: fakeDb, ARCHIVE_FILES: fakeBucket, APP_ENV: "production",
    ARCHIVE_ACCEPTANCE_TOKEN: token, ARCHIVE_RUNTIME_MEMORY_LIMIT_BYTES: "2147483648",
  }));
  assert.equal((await GET(request("logs"))).status, 404);

  setArchiveBindingsProvider(() => ({
    DB: fakeDb, ARCHIVE_FILES: fakeBucket, APP_ENV: "staging",
    ARCHIVE_ACCEPTANCE_TOKEN: token, ARCHIVE_RUNTIME_MEMORY_LIMIT_BYTES: "2147483648",
  }));
  assert.equal((await GET(request("logs", "Bearer wrong"))).status, 401);

  configureAcceptanceObservability(true);
  logEvent("info", "acceptance.route", { correlationId: "corr-route" });
  recordRuntimeMemorySample("corr-route", 4096);
  const logs = await GET(request("logs"));
  const resources = await GET(request("resources"));
  assert.equal(logs.status, 200);
  assert.equal(logs.headers.get("cache-control"), "no-store, private");
  const logBody = await logs.json() as { records: unknown[] };
  const resourceBody = await resources.json() as { samples: unknown[] };
  assert.equal(logBody.records.length, 1);
  assert.equal(resourceBody.samples.length, 1);
});
