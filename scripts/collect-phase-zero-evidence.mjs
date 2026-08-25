#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function deploymentDigest(deployment) {
  return createHash("sha256").update(JSON.stringify(deployment)).digest("hex");
}

/** Salt-okunur canlı yanıtlardan Faz 0 çıkış sözleşmesini kurar. */
export function buildPhaseZeroEvidence({ deployment, deploymentEvidenceDigest, health, acceptance, detail, correlationId, collectedAt }) {
  if (deployment?.event !== "deployment.verified" || deployment.environment !== "staging"
      || !GIT_SHA.test(String(deployment.gitCommit ?? "")) || deployment.health !== "ready") {
    fail("PHASE_ZERO_DEPLOYMENT_NOT_PROVEN");
  }
  if (health?.status !== "ready" || health?.checks?.schema?.ok !== true
      || health.checks.schema.version !== deployment.schemaVersion) {
    fail("PHASE_ZERO_HEALTH_NOT_READY");
  }
  if (acceptance?.terminalStatus !== "ACCEPTED" || acceptance?.transitionChain?.valid !== true
      || acceptance?.counts?.documents !== 1 || acceptance?.counts?.originalObjects !== 1
      || acceptance?.counts?.ocrJobs !== 1 || acceptance?.counts?.verifiedPromotions !== 1
      || !SAFE_ID.test(String(acceptance?.documentId ?? ""))) {
    fail("PHASE_ZERO_INGEST_NOT_PROVEN");
  }
  const lifecycle = acceptance?.pilotLifecycle;
  if (lifecycle?.documentId !== acceptance.documentId || lifecycle?.documentStatus !== "archived"
      || detail?.document?.id !== acceptance.documentId || detail?.document?.status !== "archived") {
    fail("PHASE_ZERO_ARCHIVE_NOT_PROVEN");
  }
  if (!SAFE_ID.test(String(lifecycle?.ocrJobId ?? "")) || lifecycle?.ocrJobStatus !== "completed"
      || typeof lifecycle?.ocrModel !== "string" || !lifecycle.ocrModel.trim()
      || !Number.isSafeInteger(lifecycle?.pageCount) || lifecycle.pageCount < 1
      || detail?.ocrJob?.id !== lifecycle.ocrJobId || detail?.ocrJob?.status !== lifecycle.ocrJobStatus
      || detail?.ocrJob?.model !== lifecycle.ocrModel || !Array.isArray(detail?.pages)
      || detail.pages.length !== lifecycle.pageCount) {
    fail("PHASE_ZERO_OCR_NOT_PROVEN");
  }
  if (!Number.isSafeInteger(lifecycle.cronOcrEvent)) fail("PHASE_ZERO_CRON_NOT_PROVEN");
  if (!Number.isSafeInteger(lifecycle.archiveEvent) || !lifecycle.archiveActor) {
    fail("PHASE_ZERO_ARCHIVE_AUDIT_NOT_PROVEN");
  }

  return {
    contractVersion: 1,
    result: "PASS",
    environment: "staging",
    gitCommit: deployment.gitCommit,
    collectedAt,
    deploymentEvidenceDigest: SHA256.test(String(deploymentEvidenceDigest ?? ""))
      ? deploymentEvidenceDigest : deploymentDigest(deployment),
    schemaVersion: health.checks.schema.version,
    health: { status: health.status, correlationId: health.correlationId },
    pilot: {
      sessionId: acceptance.sessionId,
      documentId: detail.document.id,
      uploadedBy: lifecycle.uploadedBy,
      ocrJobId: lifecycle.ocrJobId,
      modelVersion: lifecycle.ocrModel,
      correlationId,
      cronAuditEvent: lifecycle.cronOcrEvent,
      archiveAuditEvent: lifecycle.archiveEvent,
      archiveActor: lifecycle.archiveActor,
      archived: true,
    },
  };
}

async function requestJson(url, { headers = {}, correlationId }) {
  const response = await fetch(url, {
    headers: { ...headers, "x-correlation-id": correlationId },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* aşağıda güvenli hata */ }
  if (!response.ok || !body) fail(`PHASE_ZERO_HTTP_${response.status}`);
  return body;
}

async function run() {
  const root = process.env.PHASE_ZERO_BASE_URL?.trim().replace(/\/$/, "");
  const sessionId = process.env.PHASE_ZERO_SESSION_ID?.trim();
  const token = process.env.ARCHIVE_ACCEPTANCE_TOKEN?.trim();
  const identity = process.env.PHASE_ZERO_READER_IDENTITY?.trim();
  const proxyToken = process.env.ACCEPTANCE_PROXY_TOKEN?.trim();
  const deploymentPath = process.env.PHASE_ZERO_DEPLOYMENT_EVIDENCE_PATH?.trim();
  if (!root || !/^https:\/\//.test(root)) fail("PHASE_ZERO_BASE_URL_INVALID");
  if (!SAFE_ID.test(sessionId ?? "")) fail("PHASE_ZERO_SESSION_ID_INVALID");
  if (!token || token.length < 32) fail("ARCHIVE_ACCEPTANCE_TOKEN_INVALID");
  if (!identity || !identity.includes("@")) fail("PHASE_ZERO_READER_IDENTITY_INVALID");
  if (!deploymentPath) fail("PHASE_ZERO_DEPLOYMENT_EVIDENCE_MISSING");

  const deploymentBytes = await readFile(deploymentPath);
  const deployment = JSON.parse(deploymentBytes.toString("utf8"));
  const exactDeploymentDigest = createHash("sha256").update(deploymentBytes).digest("hex");
  const correlationId = `phase0-${randomUUID()}`;
  const identityHeaders = {
    "oai-authenticated-user-email": identity,
    ...(proxyToken?.length >= 32 ? { "x-acceptance-proxy-token": proxyToken } : {}),
  };
  const [health, acceptance] = await Promise.all([
    requestJson(`${root}/api/health`, { correlationId }),
    requestJson(`${root}/api/admin/acceptance-evidence/${encodeURIComponent(sessionId)}`, {
      correlationId, headers: { authorization: `Bearer ${token}` },
    }),
  ]);
  const detail = await requestJson(`${root}/api/documents/${encodeURIComponent(acceptance.documentId ?? "")}`, {
    correlationId, headers: identityHeaders,
  });
  const evidence = buildPhaseZeroEvidence({
    deployment, deploymentEvidenceDigest: exactDeploymentDigest,
    health, acceptance, detail, correlationId, collectedAt: new Date().toISOString(),
  });
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(JSON.stringify({ event: "phase-zero.evidence-failed", errorCode: error?.code ?? "PHASE_ZERO_ERROR" }));
    process.exitCode = 1;
  });
}
