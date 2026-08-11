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
  const accessTickets = new Map();
  const viewSessions = new Map();
  const now = options.now ?? (() => Date.now());
  let counter = 0;
  let viewTicketRequests = 0;

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
      observed: [],
      payload: null,
      secondDerivativeEnqueued: false,
      accessAudit: [],
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
      const document = {
        id: `doc-${counter}`,
        referenceNo: `ARS-2026-${counter}`,
        originalName: session.name,
        sha256: sha256Hex(session.payload),
        byteSize: session.payload.byteLength,
        unit: session.unit,
        mediaType: session.mediaType,
        payload: session.payload,
      };
      documents.push(document);
      session.documentId = document.id;
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


  function acceptanceEvidence(session) {
    const terminalStatus = session.observed.at(-1)
      ?? session.pollQueue.at(-1) ?? session.plan.completeStatus ?? "QUARANTINED";
    const malware = session.name.includes("-eicar.pdf");
    const rejected = terminalStatus === "REJECTED";
    const accepted = terminalStatus === "ACCEPTED";
    const duplicate = terminalStatus === "DUPLICATE";
    const decisionCode = session.plan.evidenceDecisionCode
      ?? (malware && rejected ? "MALWARE_DETECTED"
        : rejected ? "TYPE_MISMATCH"
          : duplicate ? "DUPLICATE"
            : accepted ? "ACCEPTED_AND_VERIFIED" : "INCONCLUSIVE");
    const zero = { documents: 0, originalObjects: 0, ocrJobs: 0, verifiedPromotions: 0 };
    const one = { documents: 1, originalObjects: 1, ocrJobs: 1, verifiedPromotions: 1 };
    const counts = session.plan.evidenceCounts ?? (accepted ? one : zero);
    const statuses = ["UPLOADING", ...session.observed];
    const events = statuses.map((to, index) => ({
      number: index + 1,
      from: index === 0 ? "CREATED" : statuses[index - 1],
      to,
      actorKind: "service",
      createdAt: new Date(Date.UTC(2026, 6, 31, 10, 0, index)).toISOString(),
    }));
    const duplicateDocument = duplicate && session.payload
      ? documents.find((document) => document.sha256 === sha256Hex(session.payload))
      : null;
    const body = {
      contractVersion: 1,
      sessionId: session.id,
      terminalStatus,
      decisionCode,
      duplicateOfDocumentId: duplicateDocument?.id ?? null,
      receipt: {
        id: `receipt-${session.id}`,
        result: rejected ? "REJECTED" : "VERIFIED",
        sha256: session.payload ? sha256Hex(session.payload) : "0".repeat(64),
        byteSize: session.payload?.byteLength ?? session.byteSize,
        typeValidationResult: rejected && !malware ? "MISMATCH" : "MATCH",
        parserResult: "VALID",
        scannerEngine: "clamav",
        scannerVersion: "1.4.3",
        scannerSignatureVersion: "2026073101",
        scannerResult: malware && rejected ? "MALICIOUS" : "CLEAN",
      },
      transitionChain: { valid: session.plan.chainValid ?? true, headHash: "a".repeat(64), events },
      counts,
      originalInventory: accepted ? [{
        id: `original-${session.documentId}`,
        sha256: sha256Hex(session.payload),
        byteSize: session.payload.byteLength,
        storageVersionId: options.originalStorageVersionId ?? "version-original-1",
      }] : [],
      derivativeInventory: accepted && session.secondDerivativeEnqueued ? [1, 2].map((version) => ({
        id: `access-v${version}-${session.documentId}`,
        sha256: sha256Hex(Buffer.concat([session.payload, Buffer.from(`-access-v${version}`)])),
        byteSize: session.payload.byteLength + 10,
        mediaType: "application/pdf",
        derivedFromId: `original-${session.documentId}`,
        generator: `pdfium:141.0:access-pdf-v${version}`,
        generationId: `generation-v${version}-${session.documentId}`,
        pageStart: 1,
        pageEnd: 1,
      })) : [],
      derivativeJobs: accepted && session.secondDerivativeEnqueued ? [1, 2].map((version) => ({
        id: `generation-v${version}-${session.documentId}`,
        sourceBinaryObjectId: `original-${session.documentId}`,
        profileVersion: `access-pdf-v${version}`,
        status: "COMPLETED",
        renderer: "pdfium",
        rendererVersion: "141.0",
        rendererImageDigest: `sha256:${String(version).repeat(64)}`,
        pageCount: 1,
        segmentCount: 1,
        completedAt: `2026-07-31T10:0${version}:00.000Z`,
      })) : [],
      accessAudit: session.accessAudit,
      legacyKeyMigrations: options.legacyKeyMigrations ?? { total: 0, byStatus: {} },
    };
    return options.evidenceTransform ? options.evidenceTransform(body, session) : body;
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
        session.observed.push(status);
        return ok({ session: { ...view(session), status } });
      }
      if (method === "POST" && path.startsWith("/api/admin/acceptance-evidence/")) {
        const sessionId = decodeURIComponent(path.split("/").at(-1));
        const session = sessions.get(sessionId);
        if (!session) return err(404, "SESSION_NOT_FOUND");
        if (request.body?.action === "RESOLVE_PRIVATE_OBJECT_LOCATOR") {
          const objectClass = request.body.objectClass;
          if (!["original", "quarantine"].includes(objectClass) || !session.payload) {
            return err(404, "PRIVATE_LOCATOR_NOT_FOUND");
          }
          return ok({
            objectKey: `${objectClass}/${session.id}`,
            objectClass,
            sha256: sha256Hex(session.payload),
            byteSize: session.payload.byteLength,
          });
        }
        if (request.body?.action === "RUN_INTEGRITY_MISMATCH_PROBE") {
          const sessionSha = session.payload ? sha256Hex(session.payload) : "0".repeat(64);
          return ok({
            run: {
              id: `integrity-${sessionId}`, status: "COMPLETED", profile: "full",
              snapshotMaxRowid: 12, checkedCount: 1, findingCount: 1,
            },
            finding: {
              id: `finding-${sessionId}`, binaryObjectId: `original-${session.documentId}`,
              objectKeyDigest: "d".repeat(64), findingType: "HASH_MISMATCH",
              expectedSha256: sessionSha, actualSha256: "e".repeat(64),
              severity: "CRITICAL", status: "OPEN",
            },
            alarm: {
              event: "integrity.finding-created", correlationId: `finding-${sessionId}`,
            },
            transientProviderFailure: {
              propagatedForRetry: true, persistedFindingCount: 0,
            },
            originalAfterProbe: {
              sha256: sessionSha, byteSize: session.payload?.byteLength ?? 0, unchanged: true,
            },
          });
        }
        if (["RUN_RECONCILIATION_PROBE", "RUN_POST_PROMOTION_DB_FAILURE_PROBE"]
          .includes(request.body?.action)) {
          if (options.reconciliationProbeStatus) {
            return err(options.reconciliationProbeStatus, "RECONCILIATION_PROBE_FAILED");
          }
          const response = options.reconciliationProbeResponse ?? {
            run: {
              id: `reconciliation-${sessionId}`, status: "COMPLETED",
              binarySnapshotMaxRowid: 10, documentSnapshotMaxRowid: 5,
              checkedCount: 4, findingCount: 2,
              startedAt: "2026-07-31T10:00:00.000Z", completedAt: "2026-07-31T10:00:01.000Z",
            },
            findings: [
              { id: "finding-orphan", recordKind: "STORAGE_OBJECT", recordId: null,
                objectKeyDigest: "a".repeat(64), findingType: "ORPHAN_OBJECT", severity: "HIGH", status: "OPEN" },
              { id: "finding-missing", recordKind: "BINARY_OBJECT", recordId: "recon-obj-test",
                objectKeyDigest: "b".repeat(64), findingType: "MISSING_OBJECT", severity: "CRITICAL", status: "OPEN" },
            ],
            expectations: {
              orphanKeyDigest: "a".repeat(64), missingObjectId: "recon-obj-test",
              youngKeyDigest: "c".repeat(64), orphanObjectStillPresent: true,
              youngControlFindingCount: 0,
            },
          };
          return ok(request.body.action === "RUN_POST_PROMOTION_DB_FAILURE_PROBE"
            ? { ...response, probeMode: "POST_PROMOTION_DB_FAILURE" }
            : response);
        }
        if (request.body?.action !== "ENQUEUE_SECOND_DERIVATIVE_PROFILE") {
          return err(400, "UNKNOWN_ACCEPTANCE_ACTION");
        }
        if (options.derivativeEnqueueStatus) {
          return err(options.derivativeEnqueueStatus, "DERIVATIVE_ENQUEUE_FAILED");
        }
        const enqueued = !session.secondDerivativeEnqueued;
        session.secondDerivativeEnqueued = true;
        return ok({ profileVersion: "access-pdf-v2", enqueued }, enqueued ? 202 : 200);
      }
      if (method === "GET" && path.startsWith("/api/admin/acceptance-evidence/")) {
        if (options.evidenceStatus) return err(options.evidenceStatus, "EVIDENCE_UNAVAILABLE");
        const sessionId = decodeURIComponent(path.split("/").at(-1));
        const session = sessions.get(sessionId);
        if (!session) return err(404, "SESSION_NOT_FOUND");
        return ok(acceptanceEvidence(session));
      }
      if (method === "GET" && /^\/api\/uploads\/[^/]+\/file$/.test(path)) {
        return err(404, "ROUTE_NOT_FOUND");
      }

      if (method === "GET" && path.startsWith("/api/documents?q=")) {
        return listDocuments(decodeURIComponent(path.split("=")[1]));
      }
      if (method === "GET" && path.startsWith("/api/documents/")) {
        const id = path.split("/")[3];
        const document = documents.find((entry) => entry.id === id);
        if (!document) return err(404, "DOCUMENT_NOT_FOUND");
        return ok({
          document: {
            id: document.id,
            referenceNo: document.referenceNo,
            originalName: document.originalName,
            sha256: document.sha256,
            byteSize: document.byteSize,
          },
        });
      }
      if (method === "POST" && path.endsWith("/access-ticket")) {
        const scope = request.body?.scope;
        if (scope === "VIEW") {
          viewTicketRequests += 1;
          if (viewTicketRequests <= (options.viewTicketPendingAttempts ?? 0)) {
            return err(425, "DERIVATIVE_PENDING");
          }
        }
        if (options.ticketResponse) return options.ticketResponse;
        const documentId = path.split("/")[3];
        const token = String.fromCharCode(84 + (accessTickets.size % 6)).repeat(43);
        const expiresAt = new Date(now() + 60_000).toISOString();
        accessTickets.set(token, { documentId, scope, consumed: false, expiresAt });
        const owner = [...sessions.values()].find((session) => session.documentId === documentId);
        owner?.accessAudit.push({
          eventNumber: owner.accessAudit.length + 1,
          action: "document.ticket-issued",
          details: { scope, purpose: request.body?.purpose, objectClass: scope === "VIEW" ? "access" : "original" },
          createdAt: new Date(now()).toISOString(),
        });
        return ok({ ticket: token, scope, expiresAt }, 201);
      }
      throw new Error(`beklenmeyen json çağrısı: ${method} ${path}`);
    },
    async putPart(path, { partNumber, sha256, bytes }) {
      calls.push({ method: "PUT", path, partNumber });
      const session = sessions.get(path.split("/")[3]);
      if (!session) return err(404, "SESSION_NOT_FOUND");
      if ((options.verifyPartChecksum ?? true) && sha256Hex(bytes) !== sha256) {
        return options.partChecksumError ?? err(422, "PART_CHECKSUM_MISMATCH");
      }
      session.parts.set(partNumber, Uint8Array.from(bytes));
      return ok({ session: view(session) });
    },
    async getBytes(path, { headers } = {}) {
      calls.push({ method: "GET", path, headers });
      if (options.requireFileCredential && !headers?.authorization) {
        return { status: 403, ok: false, bytes: new Uint8Array(), contentType: null, contentLength: 0, objectClass: null };
      }
      const document = documents.find((entry) => path.includes(entry.id));
      if (!document) return { status: 404, ok: false, bytes: new Uint8Array(), contentType: null, contentLength: 0, objectClass: null };
      let responseSessionToken = null;
      if (options.enforceTickets) {
        const credential = /^(ArchiveTicket|ArchiveSession) ([A-Za-z0-9_-]{43})$/.exec(headers?.authorization ?? "");
        const owner = [...sessions.values()].find((session) => session.documentId === document.id);
        const deny = (reason) => {
          owner?.accessAudit.push({
            eventNumber: owner.accessAudit.length + 1,
            action: "document.access-denied",
            details: { reason },
            createdAt: new Date(now()).toISOString(),
          });
          return { status: 403, ok: false, bytes: new Uint8Array(), contentType: null,
            contentLength: 0, objectClass: null, sessionToken: null };
        };
        if (!credential) return deny("CREDENTIAL_REQUIRED");
        if (credential[1] === "ArchiveTicket") {
          const ticket = accessTickets.get(credential[2]);
          if (!ticket || (ticket.consumed && !options.allowTicketReplay)
            || ticket.documentId !== document.id
            || ticket.scope !== headers?.["x-archive-access-scope"]
            || (now() >= Date.parse(ticket.expiresAt) && !options.allowExpiredTickets)) return deny("TICKET_INVALID");
          ticket.consumed = true;
          if (ticket.scope === "VIEW") {
            responseSessionToken = "S".repeat(43);
            viewSessions.set(responseSessionToken, { documentId: document.id });
          }
        } else {
          const session = viewSessions.get(credential[2]);
          if (!session || (session.documentId !== document.id && !options.allowCrossDocumentSession)
            || headers?.["x-archive-access-scope"] !== "VIEW") return deny("SESSION_INVALID");
        }
        if (headers?.["x-archive-access-scope"] === "VIEW") {
          owner?.accessAudit.push({
            eventNumber: owner.accessAudit.length + 1,
            action: "document.viewed",
            details: { servedObjectClass: "access", purpose: "DOCUMENT_REVIEW", ranged: false },
            createdAt: new Date(now()).toISOString(),
          });
        }
      }
      const viewScope = headers?.["x-archive-access-scope"] === "VIEW";
      const bytes = viewScope
        ? Uint8Array.from(Buffer.concat([document.payload, Buffer.from("-access-v2")]))
        : Uint8Array.from(document.payload);
      if (options.corruptDownload && !viewScope) bytes[0] ^= 0xff;
      return {
        status: 200,
        ok: true,
        bytes,
        contentType: document.mediaType,
        contentLength: bytes.byteLength,
        objectClass: viewScope ? (options.viewObjectClass ?? "access")
          : (options.downloadObjectClass ?? "original"),
        sessionToken: responseSessionToken,
      };
    },
  };
}
