export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export type StructuredLogRecord = LogFields & {
  timestamp: string;
  level: LogLevel;
  event: string;
};

export type RuntimeMemorySample = {
  timestamp: string;
  correlationId: string;
  memoryBytes: number;
};

// Yalnız kısa ömürlü staging kabul kanıtı içindir. Üretim log deposunun yerini
// almaz; sabit üst sınır süreç belleğinin denetimsiz büyümesini engeller.
const EVIDENCE_RING_LIMIT = 4096;
const recentLogs: StructuredLogRecord[] = [];
const recentMemorySamples: RuntimeMemorySample[] = [];
let evidenceCaptureEnabled = false;

function appendBounded<T>(target: T[], value: T) {
  target.push(value);
  if (target.length > EVIDENCE_RING_LIMIT) target.splice(0, target.length - EVIDENCE_RING_LIMIT);
}

function safeFields(fields: LogFields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** Worker loglarını makine tarafından işlenebilir tek satır JSON olarak yazar. */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}) {
  const structured: StructuredLogRecord = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeFields(fields),
  };
  if (evidenceCaptureEnabled) appendBounded(recentLogs, structured);
  const record = JSON.stringify(structured);
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.log(record);
}

/** Node HTTP köprüsü her isteğin başında/sonunda çağırır; gövde tutulmaz. */
export function recordRuntimeMemorySample(correlation: string, memoryBytes: number) {
  if (!evidenceCaptureEnabled || !/^[a-zA-Z0-9._-]{8,80}$/.test(correlation)
      || !Number.isSafeInteger(memoryBytes) || memoryBytes < 0) return;
  appendBounded(recentMemorySamples, {
    timestamp: new Date().toISOString(),
    correlationId: correlation,
    memoryBytes,
  });
}

/** Yalnız Node staging önyüklemesi açar; Workers/production varsayılanı kapalıdır. */
export function configureAcceptanceObservability(enabled: boolean) {
  evidenceCaptureEnabled = enabled;
  if (!enabled) {
    recentLogs.length = 0;
    recentMemorySamples.length = 0;
  }
}

/** Staging kabul ucu için salt-okunur, kopyalanmış görünüm. */
export function readRecentStructuredLogs(correlation: string, limit = 500) {
  const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
  return recentLogs
    .filter((record) => record.correlationId === correlation)
    .slice(-bounded)
    .map((record) => ({ ...record }));
}

/** Staging kabul ucu için salt-okunur, kopyalanmış görünüm. */
export function readRecentRuntimeMemorySamples(correlation: string) {
  return recentMemorySamples
    .filter((sample) => sample.correlationId === correlation)
    .map((sample) => ({ ...sample }));
}

/** Yalnız test izolasyonu. */
export function resetAcceptanceObservabilityForTests() {
  recentLogs.length = 0;
  recentMemorySamples.length = 0;
  evidenceCaptureEnabled = false;
}

export function correlationId(request?: Request) {
  const supplied = request?.headers.get("x-correlation-id")?.trim();
  return supplied && /^[a-zA-Z0-9._-]{8,80}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

export async function measured<T>(event: string, fields: LogFields, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await operation();
    logEvent("info", event, { ...fields, outcome: "success", durationMs: Date.now() - started });
    return result;
  } catch (error) {
    logEvent("error", event, {
      ...fields,
      outcome: "failure",
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
