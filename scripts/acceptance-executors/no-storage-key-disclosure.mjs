/**
 * T-04 ? Normal kullan?c? hi?bir uygulama yan?t?ndan bucket/nesne anahtar? alamaz.
 */

import { randomUUID } from "node:crypto";

import { driveSingleUpload, fail, failureEvidence } from "./flows.mjs";
import { buildPdfFixture } from "./fixtures.mjs";

const FORBIDDEN_FIELD = /(^|_)(bucket|namespace|object_?key|storage_?key|provider_?token|provider_?etag)($|_)/i;
const EVIDENCE_KINDS = ["access-denial", "secret-scan"];

function fieldPaths(value, prefix = "") {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => fieldPaths(entry, `${prefix}[${index}]`));
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...fieldPaths(entry, path)];
  });
}

export async function runNoStorageKeyDisclosure(client, ctx) {
  const correlationId = `${ctx.runId}:T-04`;
  const writeEvidence = ctx.writeEvidence;
  const tag = `t04-${ctx.runId}-${randomUUID()}`;
  const originalName = `${tag}.pdf`;
  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Yaz? ??leri",
    originalName,
    mediaType: "application/pdf",
    bytes: buildPdfFixture({ text: tag }),
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  const failEvidence = (detail) => failureEvidence(
    writeEvidence, "T-04", EVIDENCE_KINDS, { correlationId, ...detail },
  );
  if (flow.failed || flow.poll.status !== "ACCEPTED") {
    return fail(correlationId, "T04_UPLOAD_NOT_ACCEPTED",
      await failEvidence({ flow: flow.failed ?? { finalStatus: flow.poll.status } }));
  }

  const listed = await client.json("GET", `/api/documents?q=${encodeURIComponent(tag)}`);
  const document = Array.isArray(listed.body?.documents)
    ? listed.body.documents.find((entry) => entry.originalName === originalName) : null;
  if (!listed.ok || !document) {
    return fail(correlationId, "T04_DOCUMENT_NOT_FOUND",
      await failEvidence({ documentListStatus: listed.status }));
  }
  const detail = await client.json("GET", `/api/documents/${document.id}`);
  const ticket = await client.json("POST", `/api/documents/${document.id}/access-ticket`, {
    body: { scope: "DOWNLOAD", purpose: "ORIGINAL_DOWNLOAD" },
  });
  const denied = await client.getBytes(`/api/documents/${document.id}/file`);

  const surfaces = [
    ["upload", { session: { status: flow.poll.status, sha256: flow.serverSha } }],
    ["list", listed.body],
    ["detail", detail.body],
    ["ticket", ticket.body ? { ...ticket.body, ticket: ticket.body.ticket ? "[REDACTED]" : null } : null],
  ];
  const exposedPaths = surfaces.flatMap(([surface, body]) => fieldPaths(body)
    .filter((path) => FORBIDDEN_FIELD.test(path.split(".").at(-1)))
    .map((path) => `${surface}:${path}`));
  const accessDenial = await writeEvidence("T-04-access-denial", "access-denial", {
    testId: "T-04",
    correlationId,
    documentId: document.id,
    directFileStatus: denied.status,
    directFileDenied: denied.status === 403,
    assertion: "a normal user cannot bypass the ticket boundary to obtain an object",
  });
  const secretScan = await writeEvidence("T-04-secret-scan", "secret-scan", {
    testId: "T-04",
    correlationId,
    inspectedSurfaces: surfaces.map(([surface]) => surface),
    exposedPaths,
    ticketIssued: ticket.ok && typeof ticket.body?.ticket === "string",
    assertion: "normal application JSON contains no storage locator or provider credential field",
  });
  const evidence = [accessDenial, secretScan];
  if (!detail.ok || !ticket.ok) {
    return { result: "FAIL", correlationId, errorCode: "T04_SURFACE_UNAVAILABLE", evidence };
  }
  if (exposedPaths.length > 0) {
    return { result: "FAIL", correlationId, errorCode: "T04_STORAGE_KEY_DISCLOSED", evidence };
  }
  if (denied.status !== 403) {
    return { result: "FAIL", correlationId, errorCode: "T04_DIRECT_ACCESS_NOT_DENIED", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
