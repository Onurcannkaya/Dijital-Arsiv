import { acceptanceEvidenceAccessDecision } from "../../../../lib/acceptance-evidence.ts";
import { resolveArchiveBindings } from "../../../../lib/archive-bindings.ts";
import { jsonError } from "../../../../lib/http.ts";
import {
  correlationId, readRecentRuntimeMemorySamples, readRecentStructuredLogs,
} from "../../../../lib/observability.ts";

export const dynamic = "force-dynamic";

function noStore(response: Response, requestId: string) {
  response.headers.set("cache-control", "no-store, private");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-correlation-id", requestId);
  return response;
}

function validCorrelation(value: string | null) {
  return value && /^[a-zA-Z0-9._-]{8,80}$/.test(value) ? value : null;
}

/**
 * Sadece staging kabul koşusuna açık, kısa ömürlü kanıt görünümü.
 * Üretimde acceptanceEvidenceAccessDecision daima 404 verir. Ham istek
 * gövdeleri, başlıklar, fiziksel nesne anahtarları ve sırlar burada tutulmaz.
 */
export async function GET(request: Request) {
  const requestId = correlationId(request);
  const bindings = resolveArchiveBindings();
  const refused = await acceptanceEvidenceAccessDecision({
    appEnv: bindings.APP_ENV,
    configuredToken: bindings.ARCHIVE_ACCEPTANCE_TOKEN,
    authorization: request.headers.get("authorization"),
  });
  if (refused) return noStore(jsonError(refused.message, refused.status), requestId);

  const url = new URL(request.url);
  const requestedCorrelation = validCorrelation(url.searchParams.get("correlationId"));
  if (!requestedCorrelation) {
    return noStore(jsonError("Geçerli korelasyon kimliği zorunludur."), requestId);
  }

  const kind = url.searchParams.get("kind");
  if (kind === "logs") {
    const limit = Number(url.searchParams.get("limit") ?? 500);
    return noStore(Response.json({
      records: readRecentStructuredLogs(requestedCorrelation, Number.isFinite(limit) ? limit : 500),
      source: "node-bounded-structured-log-ring",
    }), requestId);
  }
  if (kind === "resources") {
    const memoryLimitBytes = Number(bindings.ARCHIVE_RUNTIME_MEMORY_LIMIT_BYTES);
    if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) {
      return noStore(jsonError("Çalışma zamanı bellek tavanı yapılandırılmamış.", 503), requestId);
    }
    return noStore(Response.json({
      samples: readRecentRuntimeMemorySamples(requestedCorrelation),
      memoryLimitBytes,
      source: "node-process-rss-bounded-samples",
    }), requestId);
  }
  return noStore(jsonError("Geçersiz gözlemlenebilirlik kanıt türü."), requestId);
}
