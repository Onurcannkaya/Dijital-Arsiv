export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

function safeFields(fields: LogFields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** Worker loglarını makine tarafından işlenebilir tek satır JSON olarak yazar. */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}) {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeFields(fields),
  });
  if (level === "error") console.error(record);
  else if (level === "warn") console.warn(record);
  else console.log(record);
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
