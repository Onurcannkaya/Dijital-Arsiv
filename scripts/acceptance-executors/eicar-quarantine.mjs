/**
 * K-2 — EICAR karantinada reddedilir.
 *
 * İmza, tür/ayrıştırıcı doğrulamasını geçen GEÇERLİ bir PDF'in yorum satırına
 * gömülür: ClamAV gövde imzası dosyanın herhangi bir ofsetinde eşleşir, buna
 * karşılık tür denetimi MATCH kalır. Aynı anda içeriği bire bir eş ama imzasız
 * bir kontrol PDF'i yüklenir; kontrol ACCEPTED, EICAR'lı eş REJECTED olduğunda
 * red kararının içerik taramasından geldiği dışarıdan atfedilebilir. İmza ve
 * yük baytları kanıt dosyalarına asla yazılmaz; yalnız SHA-256 özetleri kaydedilir.
 */

import { randomUUID } from "node:crypto";

import {
  driveSingleUpload, fail, failureEvidence, readAcceptanceEvidence, redact,
} from "./flows.mjs";
import { EICAR_SHA256, buildPdfFixture, eicarSignature } from "./fixtures.mjs";

const EVIDENCE_KINDS = ["malware-scan", "absence"];

function flowSummary(flow) {
  return {
    sessionId: flow.sessionId ?? null,
    sha256: flow.sha256,
    completeStatus: flow.afterComplete ?? null,
    observedStatuses: flow.poll?.observed ?? [],
    finalStatus: flow.poll?.status ?? null,
    timedOut: flow.poll?.timedOut ?? false,
    failed: flow.failed ?? null,
  };
}

export async function runEicarQuarantine(client, ctx) {
  const correlationId = `${ctx.runId}:K-2`;
  const writeEvidence = ctx.writeEvidence;
  const unit = ctx.config.unit ?? "Yazı İşleri";
  const tag = `k2-${ctx.runId}-${randomUUID()}`;

  // A/B ?ifti yaln?z EICAR yorum sat?r? bak?m?ndan farkl?d?r. G?r?n?r PDF
  // i?eri?ini veya yap?sal nesneleri de?i?tirmek, reddin taray?c?ya
  // atfedilmesini zay?flat?rd?.
  const fixtureText = `${tag}-control`;
  const eicarBytes = buildPdfFixture({ text: fixtureText, commentLine: eicarSignature() });
  const controlBytes = buildPdfFixture({ text: fixtureText });
  const timeoutMs = ctx.timeoutMs ?? 3.5 * 60_000;

  // İki akış paralel sürülür: tek yürütücü zaman bütçesine iki tam hat sığar.
  const [eicarFlow, controlFlow] = await Promise.all([
    driveSingleUpload(client, ctx, {
      unit,
      originalName: `${tag}-eicar.pdf`,
      mediaType: "application/pdf",
      bytes: eicarBytes,
      idempotencyKey: `${tag}-eicar`,
      timeoutMs,
    }),
    driveSingleUpload(client, ctx, {
      unit,
      originalName: `${tag}-control.pdf`,
      mediaType: "application/pdf",
      bytes: controlBytes,
      idempotencyKey: `${tag}-control`,
      timeoutMs,
    }),
  ]);

  if (eicarFlow.failed || controlFlow.failed) {
    return fail(correlationId, eicarFlow.failed ? "K2_UPLOAD_FLOW_FAILED" : "K2_CONTROL_FLOW_FAILED",
      await failureEvidence(writeEvidence, "K-2", EVIDENCE_KINDS, {
        correlationId,
        eicar: flowSummary(eicarFlow),
        control: flowSummary(controlFlow),
      }));
  }
  const [eicarEvidence, controlEvidence] = await Promise.all([
    readAcceptanceEvidence(client, ctx, eicarFlow.sessionId),
    readAcceptanceEvidence(client, ctx, controlFlow.sessionId),
  ]);
  const eicarDecision = eicarEvidence.ok ? eicarEvidence.body : null;
  const controlDecision = controlEvidence.ok ? controlEvidence.body : null;

  const scan = await writeEvidence("K-2-malware-scan", "malware-scan", {
    testId: "K-2",
    correlationId,
    payload: {
      container: "application/pdf",
      declaredExtension: ".pdf",
      // İmza gövdeye yazılmaz; kimliği bilinen SHA-256 ile kanıtlanır.
      embeddedSignatureSha256: EICAR_SHA256,
      signatureNote: "standard 68-byte antivirus test signature embedded as a PDF comment",
    },
    eicar: flowSummary(eicarFlow),
    control: flowSummary(controlFlow),
    authoritative: eicarDecision ? {
      decisionCode: eicarDecision.decisionCode,
      receipt: eicarDecision.receipt,
      transitionChainValid: eicarDecision.transitionChain?.valid ?? false,
    } : {
      response: redact(eicarEvidence),
    },
    controlDecisionCode: controlDecision?.decisionCode ?? null,
    controlTransitionChainValid: controlDecision?.transitionChain?.valid ?? false,
  });
  const absence = await writeEvidence("K-2-absence", "absence", {
    testId: "K-2",
    correlationId,
    reachedAccepted: eicarFlow.poll.observed.includes("ACCEPTED"),
    reachedDuplicate: eicarFlow.poll.observed.includes("DUPLICATE"),
    controlFinalStatus: controlFlow.poll.status,
    finalStatus: eicarFlow.poll.status,
    assertion: "no original or OCR job is created for a malware-rejected upload; the clean twin proves the rejection is content-based",
    authoritativeCounts: eicarDecision?.counts ?? null,
    controlCounts: controlDecision?.counts ?? null,
  });
  const evidence = [scan, absence];

  if (eicarFlow.poll.timedOut || controlFlow.poll.timedOut) {
    return { result: "FAIL", correlationId, errorCode: "K2_INCONCLUSIVE_TIMEOUT", evidence };
  }
  if (controlFlow.poll.status !== "ACCEPTED") {
    // Temiz eş kabul edilmiyorsa red kararı içerik taramasına atfedilemez.
    return { result: "FAIL", correlationId, errorCode: "K2_CONTROL_NOT_ACCEPTED", evidence };
  }
  if (eicarFlow.poll.status !== "REJECTED" || eicarFlow.poll.observed.includes("ACCEPTED")) {
    return { result: "FAIL", correlationId, errorCode: "K2_MALWARE_NOT_BLOCKED", evidence };
  }
  if (!eicarEvidence.ok || !controlEvidence.ok) {
    return { result: "FAIL", correlationId, errorCode: "K2_EVIDENCE_UNAVAILABLE", evidence };
  }
  if (controlDecision.decisionCode !== "ACCEPTED_AND_VERIFIED"
      || controlDecision.transitionChain?.valid !== true) {
    return { result: "FAIL", correlationId, errorCode: "K2_CONTROL_EVIDENCE_INVALID", evidence };
  }
  const receipt = eicarDecision.receipt;
  if (eicarDecision.decisionCode !== "MALWARE_DETECTED"
      || receipt?.scannerResult !== "MALICIOUS"
      || receipt?.typeValidationResult !== "MATCH"
      || receipt?.parserResult !== "VALID") {
    return { result: "FAIL", correlationId, errorCode: "K2_REJECTION_REASON_UNPROVEN", evidence };
  }
  if (!receipt.scannerEngine || !receipt.scannerVersion || !receipt.scannerSignatureVersion
      || [receipt.scannerEngine, receipt.scannerVersion, receipt.scannerSignatureVersion]
        .some((value) => value === "unknown")) {
    return { result: "FAIL", correlationId, errorCode: "K2_SCANNER_VERSION_UNPROVEN", evidence };
  }
  if (eicarDecision.transitionChain?.valid !== true) {
    return { result: "FAIL", correlationId, errorCode: "K2_EVENT_CHAIN_INVALID", evidence };
  }
  if (eicarDecision.counts?.documents !== 0 || eicarDecision.counts?.originalObjects !== 0
      || eicarDecision.counts?.ocrJobs !== 0 || eicarDecision.counts?.verifiedPromotions !== 0) {
    return { result: "FAIL", correlationId, errorCode: "K2_FORBIDDEN_ARTIFACT_CREATED", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
