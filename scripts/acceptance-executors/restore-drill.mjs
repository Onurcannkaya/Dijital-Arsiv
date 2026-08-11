/**
 * T-09 — Belge bağlamıyla yedekten geri yüklenir (ADR-017 tatbikatı).
 *
 * Koşuya özgü sentetik belge kabul hattından geçirilir; F1.10 taşınabilir
 * manifesti (üst veri + ilişkiler + OCR bağlamı + denetim zinciri) kanıt
 * ucundan alınır ve özeti koşucu tarafında yeniden hesaplanır (paket dışı
 * güven kökü). Paket, izole geri yükleme kovasına koşullu ilk yazmayla
 * aktarılır, hedeften tam okunup her nesnenin SHA-256'sı manifestle
 * karşılaştırılır; belge uygulama adaptöründen yeniden okunur ve toplam süre
 * RTO hedefiyle kıyaslanır.
 */

import { randomUUID } from "node:crypto";

import { driveSingleUpload, fail, failureEvidence } from "./flows.mjs";
import { buildPdfFixture } from "./fixtures.mjs";
import { createS3Client } from "./s3-contract.mjs";
import {
  acceptanceToken, fetchPortableManifest, readPackageObjects, transferAndVerifyPackage,
} from "./portable-package.mjs";

const EVIDENCE_KINDS = ["restore", "integrity"];

export async function runRestoreDrill(client, ctx) {
  const correlationId = `${ctx.runId}:T-09`;
  const clock = ctx.now ?? (() => Date.now());
  const tag = `t09-${ctx.runId}-${randomUUID()}`;
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-09", EVIDENCE_KINDS, {
    correlationId, ...detail,
  });

  const startedAt = clock();
  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Kabul Testleri",
    originalName: `${tag}.pdf`,
    mediaType: "application/pdf",
    bytes: buildPdfFixture({ text: tag }),
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  if (flow.failed || flow.poll.status !== "ACCEPTED") {
    return fail(correlationId, "T09_FIXTURE_UPLOAD_FAILED", await failEvidence({
      flow: flow.failed ?? null, finalStatus: flow.poll?.status ?? null,
    }));
  }
  const token = acceptanceToken(ctx);
  if (typeof token !== "string" || token.length < 32) {
    return fail(correlationId, "T09_ACCEPTANCE_TOKEN_MISSING", await failEvidence({}));
  }

  const exportStartedAt = clock();
  const pkg = await fetchPortableManifest(client, ctx, flow.sessionId);
  if (!pkg.ok) {
    return fail(correlationId, "T09_MANIFEST_EXPORT_FAILED",
      await failEvidence({ exportStatus: pkg.status }));
  }
  if (!pkg.digestVerified) {
    return fail(correlationId, "T09_MANIFEST_DIGEST_MISMATCH", await failEvidence({
      recomputedDigest: pkg.manifestDigest, reportedDigest: pkg.reportedDigest,
    }));
  }
  const source = await readPackageObjects(ctx, pkg, "T09");
  if (source.errorCode) {
    return fail(correlationId, source.errorCode, await failEvidence(source.detail));
  }
  const copyStartedAt = clock();

  const restore = createS3Client({
    endpoint: ctx.config.s3?.endpoint,
    bucket: ctx.config.s3?.restoreBucket,
    region: ctx.config.s3?.region,
    credentials: ctx.config.s3?.credentials,
    signal: ctx.signal,
    fetcher: ctx.config.s3?.fetcher,
  });
  const prefix = `restore-drill/${ctx.runId}/${pkg.documentId}`;
  const transferred = await transferAndVerifyPackage(restore, prefix, pkg, source.objects);
  if (transferred.failed) {
    return fail(correlationId, "T09_RESTORE_WRITE_FAILED", await failEvidence({
      write: transferred.failed,
    }));
  }
  const verifyDoneAt = clock();

  // Uygulama adaptörü okuma kanıtı: geri kazanılan belge yetkili kayıtla okunur.
  const detail = await client.json("GET", `/api/documents/${encodeURIComponent(pkg.documentId)}`);
  const originalObject = pkg.manifest.objects.find((object) => object.objectClass === "original");
  const appReadbackShaMatches = detail.ok
    && detail.body?.document?.sha256 === originalObject?.sha256
    && Number(detail.body?.document?.byteSize) === originalObject?.byteSize;

  const rtoSeconds = ctx.config.restoreRtoSeconds ?? 900;
  const durationsMs = {
    ingestFixture: exportStartedAt - startedAt,
    manifestExport: copyStartedAt - exportStartedAt,
    copyAndVerify: verifyDoneAt - copyStartedAt,
    total: verifyDoneAt - exportStartedAt,
  };
  const withinRto = durationsMs.total <= rtoSeconds * 1000;
  const allObjectsRestored = transferred.transfers.length === source.objects.length
    && transferred.transfers.every((transfer) => transfer.shaMatches);

  const restoreEvidence = await ctx.writeEvidence("T-09-restore", "restore", {
    testId: "T-09",
    correlationId,
    sessionId: flow.sessionId,
    documentId: pkg.documentId,
    packageVersion: pkg.manifest.packageVersion ?? null,
    restoredManifestKey: transferred.manifestKey,
    documentContext: {
      objectCount: pkg.manifest.objects.length,
      relationCount: pkg.manifest.relations?.length ?? 0,
      ocrPageCount: pkg.manifest.ocrPages?.length ?? 0,
      auditEventCount: pkg.manifest.auditChain?.length ?? 0,
    },
    appReadback: { status: detail.status, shaMatches: appReadbackShaMatches },
    durationsMs,
    rtoSeconds,
    withinRto,
  });
  const integrity = await ctx.writeEvidence("T-09-integrity", "integrity", {
    testId: "T-09",
    correlationId,
    manifestDigest: pkg.manifestDigest,
    digestRecomputedByRunner: true,
    restoredManifestShaMatches: transferred.manifestShaMatches,
    objects: transferred.transfers.map(({ objectClass, byteSize, shaMatches }) => ({
      objectClass, byteSize, shaMatches,
    })),
    allObjectsRestored,
  });
  const evidence = [restoreEvidence, integrity];

  if (!allObjectsRestored || !transferred.manifestShaMatches) {
    return { result: "FAIL", correlationId, errorCode: "T09_RESTORE_OBJECT_MISMATCH", evidence };
  }
  if (!appReadbackShaMatches) {
    return { result: "FAIL", correlationId, errorCode: "T09_APP_READBACK_FAILED", evidence };
  }
  if (!withinRto) {
    return { result: "FAIL", correlationId, errorCode: "T09_RTO_EXCEEDED", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
