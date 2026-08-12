import {
  ARCHIVE_SCHEMA_VERSION, getArchiveBindings, getArchiveObjectStorage,
  localContentScanServiceUrl, localOcrServiceUrl, readSchemaVersion,
} from "../../../lib/archive-storage";
import { correlationId, logEvent } from "../../../lib/observability";

export const dynamic = "force-dynamic";

type Check = { ok: boolean; latencyMs: number };

async function check(operation: () => Promise<unknown>): Promise<Check> {
  const started = Date.now();
  try {
    await operation();
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

/** Dağıtım sonrası smoke test için ayrıntı sızdırmayan readiness denetimi. */
export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const bindings = getArchiveBindings();
    const storage = getArchiveObjectStorage(bindings);
    const ocrUrl = localOcrServiceUrl(request, bindings.OCR_SERVICE_URL);
    const contentScanUrl = localContentScanServiceUrl(request, bindings.CONTENT_SCAN_SERVICE_URL);
    const [database, objectStorage, ocr, contentScan] = await Promise.all([
      check(() => bindings.DB.prepare("SELECT 1 AS ok").first()),
      check(() => storage.check()),
      ocrUrl
        ? check(async () => {
            const response = await fetch(`${ocrUrl}/health`, { signal: AbortSignal.timeout(5_000) });
            if (!response.ok) throw new Error("OCR health check failed");
            const state = await response.json() as { modelReady?: boolean };
            if (state.modelReady !== true) throw new Error("OCR model is not ready");
          })
        : Promise.resolve({ ok: false, latencyMs: 0 }),
      contentScanUrl
        ? check(async () => {
            const response = await fetch(`${contentScanUrl}/health`, { signal: AbortSignal.timeout(5_000) });
            if (!response.ok) throw new Error("Content scan health check failed");
            const state = await response.json() as { scannerReady?: boolean };
            if (state.scannerReady !== true) throw new Error("Content scanner is not ready");
          })
        : Promise.resolve({ ok: false, latencyMs: 0 }),
    ]);
    const schemaVersion = database.ok ? await readSchemaVersion(bindings.DB).catch(() => -1) : -1;
    const schema = { ok: schemaVersion === ARCHIVE_SCHEMA_VERSION, version: schemaVersion };
    const ready = database.ok && objectStorage.ok && ocr.ok && contentScan.ok && schema.ok;

    logEvent(ready ? "info" : "warn", "health.checked", {
      correlationId: requestId,
      ready,
      database: database.ok,
      objectStorage: objectStorage.ok,
      ocr: ocr.ok,
      contentScan: contentScan.ok,
      schemaVersion,
    });
    return Response.json({
      status: ready ? "ready" : "degraded",
      checks: { database, objectStorage, ocr, contentScan, schema },
      timestamp: new Date().toISOString(),
      correlationId: requestId,
    }, {
      status: ready ? 200 : 503,
      headers: { "cache-control": "no-store", "x-correlation-id": requestId },
    });
  } catch (error) {
    logEvent("error", "health.failed", {
      correlationId: requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({
      status: "unavailable",
      timestamp: new Date().toISOString(),
      correlationId: requestId,
    }, {
      status: 503,
      headers: { "cache-control": "no-store", "x-correlation-id": requestId },
    });
  }
}
