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

import { driveSingleUpload, fail, failureEvidence } from "./flows.mjs";
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

  const eicarBytes = buildPdfFixture({ text: `${tag}-eicar`, commentLine: eicarSignature() });
  const controlBytes = buildPdfFixture({ text: `${tag}-control` });
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
  });
  const absence = await writeEvidence("K-2-absence", "absence", {
    testId: "K-2",
    correlationId,
    reachedAccepted: eicarFlow.poll.observed.includes("ACCEPTED"),
    reachedDuplicate: eicarFlow.poll.observed.includes("DUPLICATE"),
    controlFinalStatus: controlFlow.poll.status,
    finalStatus: eicarFlow.poll.status,
    assertion: "no original or OCR job is created for a malware-rejected upload; the clean twin proves the rejection is content-based",
  });
  const evidence = [scan, absence];

  if (eicarFlow.poll.timedOut || controlFlow.poll.timedOut) {
    return { result: "FAIL", correlationId, errorCode: "K2_INCONCLUSIVE_TIMEOUT", evidence };
  }
  if (controlFlow.poll.status !== "ACCEPTED") {
    // Temiz eş kabul edilmiyorsa red kararı içerik taramasına atfedilemez.
    return { result: "FAIL", correlationId, errorCode: "K2_CONTROL_NOT_ACCEPTED", evidence };
  }
  if (eicarFlow.poll.status === "REJECTED" && !eicarFlow.poll.observed.includes("ACCEPTED")) {
    return { result: "PASS", correlationId, evidence };
  }
  return { result: "FAIL", correlationId, errorCode: "K2_MALWARE_NOT_BLOCKED", evidence };
}
