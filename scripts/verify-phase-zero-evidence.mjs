#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export function validatePhaseZeroEvidence(evidence, expectedGitCommit) {
  const failures = [];
  if (evidence?.contractVersion !== 1) failures.push("CONTRACT_VERSION_INVALID");
  if (evidence?.result !== "PASS") failures.push("RESULT_NOT_PASS");
  if (evidence?.environment !== "staging") failures.push("ENVIRONMENT_INVALID");
  if (!GIT_SHA.test(String(evidence?.gitCommit ?? "")) || evidence.gitCommit !== expectedGitCommit) {
    failures.push("GIT_COMMIT_MISMATCH");
  }
  if (!SHA256.test(String(evidence?.deploymentEvidenceDigest ?? ""))) failures.push("DEPLOYMENT_DIGEST_INVALID");
  if (!Number.isSafeInteger(evidence?.schemaVersion) || evidence.schemaVersion < 1) failures.push("SCHEMA_VERSION_INVALID");
  if (evidence?.health?.status !== "ready" || !SAFE_ID.test(String(evidence?.health?.correlationId ?? ""))) {
    failures.push("HEALTH_EVIDENCE_INVALID");
  }
  for (const field of ["sessionId", "documentId", "ocrJobId", "correlationId"]) {
    if (!SAFE_ID.test(String(evidence?.pilot?.[field] ?? ""))) failures.push(`PILOT_${field.toUpperCase()}_INVALID`);
  }
  if (typeof evidence?.pilot?.modelVersion !== "string" || !evidence.pilot.modelVersion.trim()) {
    failures.push("PILOT_MODEL_VERSION_INVALID");
  }
  if (!Number.isSafeInteger(evidence?.pilot?.cronAuditEvent)
      || !Number.isSafeInteger(evidence?.pilot?.archiveAuditEvent)
      || evidence?.pilot?.archived !== true) failures.push("PILOT_AUDIT_INVALID");
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

async function run() {
  const path = process.argv[2];
  const expectedGitCommit = process.argv[3];
  if (!path || !expectedGitCommit) throw new Error("Kullanım: verify-phase-zero-evidence.mjs <dosya> <git-sha>");
  const bytes = await readFile(path);
  const evidence = JSON.parse(bytes.toString("utf8"));
  const result = validatePhaseZeroEvidence(evidence, expectedGitCommit);
  if (!result.ok) {
    console.error(JSON.stringify({ event: "phase-zero.evidence-invalid", failures: result.failures }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    event: "phase-zero.evidence-verified",
    digest: createHash("sha256").update(bytes).digest("hex"),
    schemaVersion: evidence.schemaVersion,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => {
    console.error(JSON.stringify({ event: "phase-zero.evidence-invalid", failures: ["UNREADABLE"] }));
    process.exitCode = 1;
  });
}
