/**
 * F1.11 yürütücü testleri için durum tutan sahte staging istemcisi.
 *
 * Gerçek kabul hattının dışarıdan gözlenen sözleşmesini taklit eder: oturum
 * oluşturma/devralma (idempotency anahtarı), parça SHA doğrulaması, tamamlama
 * sonrası tam-akış SHA'sı, terminal yoklaması, belge listesi, erişim bileti ve
 * asıl indirme. Testler davranışı `planFor` ve seçeneklerle yönlendirir.
 */

import { createHash } from "node:crypto";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ok = (body, status = 200) => ({ status, ok: true, body });
const err = (status, code) => ({ status, ok: false, body: { error: code, code } });

/**
 * options:
 *   planFor(idempotencyKey, originalName) → {
 *     create?: hazır yanıt (oturum hiç açılmaz),
 *     poll?: terminal öncesi durum dizisi (son eleman tekrarlanır; vars. ["SCANNING","VERIFIED","ACCEPTED"]),
 *     completeStatus?: tamamlanma anındaki durum (vars. "QUARANTINED"),
 *     reportSha?: tamamlama yanıtında dönecek SHA (vars. gerçek birleşik özet),
 *     partSize?: sunucunun bildirdiği parça boyutu (vars. options.partSize ?? byteSize),
 *   }
 *   verifyPartChecksum (vars. true), onResume(view) → view,
 *   documentsStatus, documentsTransform(list) → list,
 *   ticketResponse, corruptDownload
 */
export function fakeStaging(options = {}) {
  const planFor = options.planFor ?? (() => ({}));
  const sessions = new Map();
  const byIdempotency = new Map();
  const documents = [];
  const calls = [];
  let counter = 0;

  function view(session, resumed) {
    const verified = [...session.parts.keys()].sort((left, right) => left - right);
    const expected = Math.max(1, Math.ceil(session.byteSize / session.partSize));
    const base = {
      id: session.id,
      status: "UPLOADING",
      multipart: expected > 1,
      partSize: session.partSize,
      expectedPartCount: expected,
      completedParts: verified,
      missingParts: Array.from({ length: expected }, (_, index) => index + 1)
        .filter((part) => !session.parts.has(part)),
    };
    if (resumed === undefined) return base;
    const resumedView = { ...base, resumed };
    return options.onResume && resumed ? options.onResume(resumedView) : resumedView;
  }

  function createSession(headers, body) {
    const idempotencyKey = headers?.["idempotency-key"] ?? "";
    const existing = byIdempotency.get(idempotencyKey);
    if (existing) return ok({ session: view(existing, true) });
    const plan = planFor(idempotencyKey, body.originalName) ?? {};
    if (plan.create) return plan.create;
    counter += 1;
    const session = {
      id: `sess-${counter}`,
      plan,
      name: body.originalName,
      unit: body.unit,
      mediaType: body.mediaType,
      byteSize: body.byteSize,
      partSize: plan.partSize ?? options.partSize ?? body.byteSize,
      parts: new Map(),
      pollQueue: [...(plan.poll ?? ["SCANNING", "VERIFIED", "ACCEPTED"])],
      payload: null,
    };
    sessions.set(session.id, session);
    byIdempotency.set(idempotencyKey, session);
    return ok({ session: { ...view(session, false), status: "UPLOADING" } }, 201);
  }

  function complete(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return err(404, "SESSION_NOT_FOUND");
    const ordered = [...session.parts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, bytes]) => bytes);
    session.payload = Buffer.concat(ordered.map((bytes) => Buffer.from(bytes)));
    const sha256 = session.plan.reportSha ?? sha256Hex(session.payload);
    const terminal = session.pollQueue[session.pollQueue.length - 1];
    if (terminal === "ACCEPTED") {
      counter += 1;
      documents.push({
        id: `doc-${counter}`,
        referenceNo: `ARS-2026-${counter}`,
        originalName: session.name,
        sha256: sha256Hex(session.payload),
        byteSize: session.payload.byteLength,
        unit: session.unit,
        mediaType: session.mediaType,
        payload: session.payload,
      });
    }
    return ok({ session: { status: session.plan.completeStatus ?? "QUARANTINED", sha256 } });
  }

  function listDocuments(query) {
    if (options.documentsStatus) return { status: options.documentsStatus, ok: false, body: {} };
    const matched = documents.filter((document) => document.originalName.includes(query));
    const transformed = options.documentsTransform ? options.documentsTransform(matched) : matched;
    // `payload` sunucu içi tutulur; liste yanıtı yalnız kayıt alanlarını taşır.
    return ok({
      documents: transformed.map((document) => ({
        id: document.id,
        referenceNo: document.referenceNo,
        originalName: document.originalName,
        sha256: document.sha256,
        byteSize: document.byteSize,
        unit: document.unit,
        mediaType: document.mediaType,
      })),
    });
  }

  return {
    calls,
    documents,
    sessions,
    async json(method, path, request = {}) {
      calls.push({ method, path });
      if (method === "POST" && path === "/api/uploads") return createSession(request.headers, request.body);
      if (method === "POST" && path.endsWith("/complete")) {
        return complete(path.split("/")[3]);
      }
      if (method === "GET" && path.startsWith("/api/uploads?id=")) {
        const session = sessions.get(decodeURIComponent(path.split("=")[1]));
        if (!session) return err(404, "SESSION_NOT_FOUND");
        const status = session.pollQueue.length > 1 ? session.pollQueue.shift() : session.pollQueue[0];
        return ok({ session: { ...view(session), status } });
      }
      if (method === "GET" && path.startsWith("/api/documents?q=")) {
        return listDocuments(decodeURIComponent(path.split("=")[1]));
      }
      if (method === "POST" && path.endsWith("/access-ticket")) {
        return options.ticketResponse ?? ok({ ticket: "T".repeat(43), scope: "DOWNLOAD" }, 201);
      }
      throw new Error(`beklenmeyen json çağrısı: ${method} ${path}`);
    },
    async putPart(path, { partNumber, sha256, bytes }) {
      calls.push({ method: "PUT", path, partNumber });
      const session = sessions.get(path.split("/")[3]);
      if (!session) return err(404, "SESSION_NOT_FOUND");
      if ((options.verifyPartChecksum ?? true) && sha256Hex(bytes) !== sha256) {
        return err(422, "PART_CHECKSUM_MISMATCH");
      }
      session.parts.set(partNumber, Uint8Array.from(bytes));
      return ok({ session: view(session) });
    },
    async getBytes(path, { headers } = {}) {
      calls.push({ method: "GET", path, headers });
      const document = documents.find((entry) => path.includes(entry.id));
      if (!document) return { status: 404, ok: false, bytes: new Uint8Array(), contentType: null, contentLength: 0 };
      const bytes = Uint8Array.from(document.payload);
      if (options.corruptDownload) bytes[0] ^= 0xff;
      return {
        status: 200,
        ok: true,
        bytes,
        contentType: document.mediaType,
        contentLength: bytes.byteLength,
      };
    },
  };
}
