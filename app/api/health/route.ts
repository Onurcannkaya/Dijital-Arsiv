import {
  ARCHIVE_SCHEMA_VERSION, getArchiveBindings, getArchiveObjectStorage,
  localContentScanServiceUrl, localOcrServiceUrl, readSchemaVersion,
} from "../../../lib/archive-storage";
import { correlationId, logEvent } from "../../../lib/observability";

export const dynamic = "force-dynamic";

type Check = { ok: boolean; latencyMs: number; configured?: boolean };

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
    /*
     * PDF erişim türevi üreticisi (ADR-015) de ölçülür: üretimde zorunlu sır
     * olduğu hâlde readiness ona hiç bakmıyordu — servis çökse sistem "ready"
     * görünüyordu. Yerel fallback yok (dev-stack render koşturmaz, compose ağı
     * `document-render:8100` kullanır); yapılandırılmamışsa denetim GÖRÜNÜR
     * (`configured:false`) ama readiness'i düşürmez: üretimde sır wrangler
     * tarafından zorunlu kılınır, yerel geliştirme ise türevsiz çalışabilir.
     */
    const renderUrl = bindings.DOCUMENT_RENDER_SERVICE_URL?.replace(/\/$/, "");
    const [database, objectStorage, ocr, contentScan, documentRender] = await Promise.all([
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
      renderUrl
        ? check(async () => {
            const response = await fetch(`${renderUrl}/health`, { signal: AbortSignal.timeout(5_000) });
            // Servis kendi yapılandırma eksiğini 503 ile bildirir (main.py /health).
            if (!response.ok) throw new Error("Document render health check failed");
            const state = await response.json() as {
              renderer?: unknown;
              rendererImageDigest?: unknown;
              profileVersion?: unknown;
            };
            if (state.renderer !== "pdfium"
              || state.profileVersion !== "access-pdf-v1"
              || typeof bindings.DOCUMENT_RENDER_IMAGE_DIGEST !== "string"
              || state.rendererImageDigest !== bindings.DOCUMENT_RENDER_IMAGE_DIGEST.toLowerCase()) {
              throw new Error("Document render provenance mismatch");
            }
          })
        : Promise.resolve({ ok: false, latencyMs: 0, configured: false }),
    ]);
    const schemaVersion = database.ok ? await readSchemaVersion(bindings.DB).catch(() => -1) : -1;
    const schema = { ok: schemaVersion === ARCHIVE_SCHEMA_VERSION, version: schemaVersion };
    const ready = database.ok && objectStorage.ok && ocr.ok && contentScan.ok
      && (renderUrl ? documentRender.ok : true) && schema.ok;

    logEvent(ready ? "info" : "warn", "health.checked", {
      correlationId: requestId,
      ready,
      database: database.ok,
      objectStorage: objectStorage.ok,
      ocr: ocr.ok,
      contentScan: contentScan.ok,
      documentRender: documentRender.ok,
      schemaVersion,
    });
    return Response.json({
      status: ready ? "ready" : "degraded",
      releaseRevision: bindings.ARCHIVE_RELEASE_REVISION ?? null,
      checks: { database, objectStorage, ocr, contentScan, documentRender, schema },
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
