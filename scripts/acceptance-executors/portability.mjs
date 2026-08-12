/**
 * T-10 — Sağlayıcı taşınabilirlik manifesti ikinci adaptörle doğrulanır.
 *
 * F1.10 paketi kaynak sağlayıcıdan okunur, ikinci S3 uyumlu hedefe bağımsız
 * kimlik bilgisiyle aktarılır ve hedeften TAM okunarak yalnız içerik SHA-256 +
 * boyutla doğrulanır. Sağlayıcı ETag/sürüm kimliği bütünlük kararına girmez;
 * kanıtta yalnız gözlem olarak raporlanır (kanıt rehberi T-10).
 */

import { randomUUID } from "node:crypto";

import { driveSingleUpload, fail, failureEvidence } from "./flows.mjs";
import { buildPdfFixture } from "./fixtures.mjs";
import { createS3Client } from "./s3-contract.mjs";
import {
  acceptanceToken, fetchPortableManifest, readPackageObjects, transferAndVerifyPackage,
} from "./portable-package.mjs";

const EVIDENCE_KINDS = ["portability", "integrity"];

function hostOf(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

export async function runProviderPortability(client, ctx) {
  const correlationId = `${ctx.runId}:T-10`;
  const tag = `t10-${ctx.runId}-${randomUUID()}`;
  const failEvidence = (detail) => failureEvidence(ctx.writeEvidence, "T-10", EVIDENCE_KINDS, {
    correlationId, ...detail,
  });

  const flow = await driveSingleUpload(client, ctx, {
    unit: ctx.config.unit ?? "Kabul Testleri",
    originalName: `${tag}.pdf`,
    mediaType: "application/pdf",
    bytes: buildPdfFixture({ text: tag }),
    idempotencyKey: tag,
    timeoutMs: ctx.timeoutMs ?? 3 * 60_000,
  });
  if (flow.failed || flow.poll.status !== "ACCEPTED") {
    return fail(correlationId, "T10_FIXTURE_UPLOAD_FAILED", await failEvidence({
      flow: flow.failed ?? null, finalStatus: flow.poll?.status ?? null,
    }));
  }
  const token = acceptanceToken(ctx);
  if (typeof token !== "string" || token.length < 32) {
    return fail(correlationId, "T10_ACCEPTANCE_TOKEN_MISSING", await failEvidence({}));
  }

  const pkg = await fetchPortableManifest(client, ctx, flow.sessionId);
  if (!pkg.ok) {
    return fail(correlationId, "T10_MANIFEST_EXPORT_FAILED",
      await failEvidence({ exportStatus: pkg.status }));
  }
  if (!pkg.digestVerified) {
    return fail(correlationId, "T10_MANIFEST_DIGEST_MISMATCH", await failEvidence({
      recomputedDigest: pkg.manifestDigest, reportedDigest: pkg.reportedDigest,
    }));
  }
  const source = await readPackageObjects(ctx, pkg, "T10");
  if (source.errorCode) {
    return fail(correlationId, source.errorCode, await failEvidence(source.detail));
  }

  let target;
  try {
    target = createS3Client({
      endpoint: ctx.config.secondProvider?.endpoint,
      bucket: ctx.config.secondProvider?.bucket,
      region: ctx.config.secondProvider?.region,
      credentials: ctx.config.secondProvider?.credentials,
      signal: ctx.signal,
      fetcher: ctx.config.secondProvider?.fetcher,
    });
  } catch {
    return fail(correlationId, "T10_SECOND_PROVIDER_UNCONFIGURED", await failEvidence({}));
  }
  const prefix = `portability/${ctx.runId}/${pkg.documentId}`;
  const transferred = await transferAndVerifyPackage(target, prefix, pkg, source.objects);
  if (transferred.failed) {
    return fail(correlationId, "T10_TARGET_WRITE_FAILED", await failEvidence({
      write: transferred.failed,
    }));
  }
  const allObjectsPortable = transferred.transfers.length === source.objects.length
    && transferred.transfers.every((transfer) => transfer.shaMatches);

  const portability = await ctx.writeEvidence("T-10-portability", "portability", {
    testId: "T-10",
    correlationId,
    sessionId: flow.sessionId,
    documentId: pkg.documentId,
    packageVersion: pkg.manifest.packageVersion ?? null,
    sourceAdapterHost: hostOf(ctx.config.s3?.endpoint),
    targetAdapterHost: hostOf(ctx.config.secondProvider?.endpoint),
    objectCount: pkg.manifest.objects.length,
    transfers: transferred.transfers.map(({ objectClass, byteSize, sourceEtagObserved, targetEtagObserved, etagsEqual }) => ({
      objectClass, byteSize, sourceEtagObserved, targetEtagObserved, etagsEqual,
    })),
    targetManifestKey: transferred.manifestKey,
  });
  const integrity = await ctx.writeEvidence("T-10-integrity", "integrity", {
    testId: "T-10",
    correlationId,
    manifestDigest: pkg.manifestDigest,
    digestRecomputedByRunner: true,
    targetManifestShaMatches: transferred.manifestShaMatches,
    objects: transferred.transfers.map(({ objectClass, byteSize, shaMatches }) => ({
      objectClass, byteSize, shaMatches,
    })),
    allObjectsPortable,
    // Kabul ölçütü: bütünlük kararı içerik SHA-256'sına dayanır; ETag/sürüm
    // kimliği sağlayıcıya özgüdür ve karara girmez.
    decisionBasis: "content-sha256",
    providerEtagUsedForDecision: false,
  });
  const evidence = [portability, integrity];

  if (!allObjectsPortable || !transferred.manifestShaMatches) {
    return { result: "FAIL", correlationId, errorCode: "T10_TARGET_OBJECT_MISMATCH", evidence };
  }
  return { result: "PASS", correlationId, evidence };
}
