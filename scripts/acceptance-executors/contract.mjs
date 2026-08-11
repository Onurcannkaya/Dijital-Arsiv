/**
 * F1.11 — Kabul yürütücüsü sözleşmesi ve ortak yardımcılar.
 *
 * Yürütücü sözleşmesi (run-phase-one-acceptance.mjs tarafından çağrılır):
 *
 *   executors[testId] = async ({ test, capabilities, config, evidenceDir,
 *     runId, signal }) => outcome
 *
 * `outcome` biçimi:
 *   {
 *     result: "PASS" | "FAIL" | "NOT_APPLICABLE",   // BLOCKED'i koşu betiği verir
 *     correlationId?: string,                        // SAFE_CORRELATION (>=8 char)
 *     errorCode?: string,                            // A-Z0-9_ sabit kod
 *     adrReference?: "ADR-016",                      // yalnız T-07 N/A
 *     compensatingControl?: { result: "PASS" },      // yalnız T-07 N/A
 *     evidence: Array<{ id, kind, path }>,           // path evidenceDir'e göreli .json
 *   }
 *
 * Yürütücü kanıt dosyalarını `evidenceDir` altına yazar; koşu betiği bunları
 * okuyup boyut/güvenli-yol/JSON/sır taramasi/SHA-256 doğrular. Açık kimlik
 * bilgisi (bilet/sır) kanıta yazılmaz.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export class ExecutorConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExecutorConfigError";
  }
}

/**
 * Uygulama HTTP istemcisi. Kimlik, uygulamanın güvendiği
 * `oai-authenticated-user-email` başlığıyla taşınır (lib/authorization.ts);
 * kabul ortamı bu sentetik kimliği kabul edecek şekilde yapılandırılır.
 */
export function createAppClient({ baseUrl, identity, signal, fetcher = fetch, correlationId }) {
  if (typeof baseUrl !== "string" || !/^https:\/\//.test(baseUrl)) {
    throw new ExecutorConfigError("Kabul yürütücüsü HTTPS taban adresi gerektirir.");
  }
  if (typeof identity !== "string" || !identity.includes("@")) {
    throw new ExecutorConfigError("Kabul yürütücüsü sentetik yükleyici kimliği gerektirir.");
  }
  const root = baseUrl.replace(/\/$/, "");
  const identityHeaders = {
    "oai-authenticated-user-email": identity,
    ...(typeof correlationId === "string" && /^[A-Za-z0-9._-]{8,80}$/.test(correlationId)
      ? { "x-correlation-id": correlationId } : {}),
  };

  async function json(method, path, { body, headers } = {}) {
    const response = await fetcher(`${root}${path}`, {
      method,
      headers: {
        ...identityHeaders,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* JSON olmayan yanıt */ }
    return { status: response.status, ok: response.ok, body: parsed };
  }

  /** İkili gövde indirir (T-02 asıl doğrulaması). Yanıt gövdesi hash'lenir, kanıta yazılmaz. */
  async function getBytes(path, { headers } = {}) {
    const response = await fetcher(`${root}${path}`, {
      method: "GET",
      headers: { ...identityHeaders, ...headers },
      signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      ok: response.ok,
      bytes,
      contentType: response.headers.get("content-type"),
      contentLength: Number(response.headers.get("content-length") ?? bytes.byteLength),
      objectClass: response.headers.get("x-archive-object-class"),
      pageStart: response.headers.get("x-archive-page-start"),
      pageEnd: response.headers.get("x-archive-page-end"),
      contentDisposition: response.headers.get("content-disposition"),
      // Yaln?z sonraki HTTP ad?m?nda kullan?l?r; kan?t dosyas?na yaz?lmas? yasakt?r.
      sessionToken: response.headers.get("x-archive-session"),
    };
  }

  async function putPart(path, { partNumber, sha256, bytes }) {
    const response = await fetcher(`${root}${path}`, {
      method: "PUT",
      headers: {
        ...identityHeaders,
        "x-part-number": String(partNumber),
        "content-length": String(bytes.byteLength),
        "x-content-sha256": sha256,
        "content-type": "application/octet-stream",
      },
      body: bytes,
      signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* yoksay */ }
    return { status: response.status, ok: response.ok, body: parsed };
  }

  return { root, json, putPart, getBytes };
}

/** Deterministik JSON kanıt dosyası yazar; koşu betiği okuyup özetler. */
export function evidenceWriter(evidenceDir) {
  return async function writeEvidence(id, kind, payload) {
    const fileName = `${id}.json`;
    const target = resolve(evidenceDir, fileName);
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { id, kind, path: fileName };
  };
}

/** İptal edilebilir bekleme; yürütücü zaman aşımı sinyaline saygı gösterir. */
export function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error("ABORTED"));
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("ABORTED")); }, { once: true });
  });
}

/**
 * Oturum durumunu terminal olana ya da süre dolana kadar yoklar. Ara durumları
 * kaydeder; kanıt yaşam döngüsünü gösterir. `now` test için enjekte edilebilir.
 */
export async function pollUploadStatus(client, sessionId, { terminal, timeoutMs = 4 * 60_000, intervalMs = 5_000, signal, now = () => Date.now() }) {
  const deadline = now() + timeoutMs;
  const observed = [];
  for (;;) {
    const response = await client.json("GET", `/api/uploads?id=${encodeURIComponent(sessionId)}`);
    const status = response.body?.session?.status ?? `HTTP_${response.status}`;
    if (observed.at(-1) !== status) observed.push(status);
    if (terminal.includes(status)) return { status, observed, timedOut: false };
    if (now() >= deadline) return { status, observed, timedOut: true };
    await sleep(intervalMs, signal);
  }
}
