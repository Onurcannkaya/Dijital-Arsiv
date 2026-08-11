/**
 * F1.11 — Kabul hattı canlı yürütücüleri (katalogdaki 19 testin tamamı).
 *
 * Her yürütücü gerçek staging uygulamasını ve/veya S3 uyumlu depoyu sürer,
 * sonucu fiziksel JSON kanıtla döndürür. Bu modül `ACCEPTANCE_EXECUTOR_MODULE`
 * ile yalnız scripts/acceptance-executors altından yüklenir. Testler birlikte
 * API → karantina → tarama → terfi → değişmez asıl → türev/erişim → yedek ve
 * taşınabilirlik zincirini uçtan uca kanıtlar.
 */

import { ExecutorConfigError, createAppClient, evidenceWriter } from "./contract.mjs";
import { runMimeMismatch } from "./mime-mismatch.mjs";
import { runEicarQuarantine } from "./eicar-quarantine.mjs";
import { runMultipartResume } from "./multipart-resume.mjs";
import { runDuplicateSha } from "./duplicate-sha.mjs";
import { runPostWriteShaVerification } from "./post-write-sha.mjs";
import { runNoStorageKeyDisclosure } from "./no-storage-key-disclosure.mjs";

import { runDerivativeIntegrity } from "./derivative-integrity.mjs";
/** Koşu betiğinin yürütücü sözleşmesini (contract.mjs başlığı) tek noktadan bağlar. */
import { runExpiredViewTicket } from "./expired-view-ticket.mjs";
import { runBidirectionalReconciliation } from "./bidirectional-reconciliation.mjs";
import { runConditionalWriteProtection } from "./conditional-write.mjs";
import { runOriginalIamSeparation } from "./original-iam-separation.mjs";
import { runQuarantineIamSeparation } from "./quarantine-iam-separation.mjs";
import { runPersonalDataSurfaceScan } from "./personal-data-scan.mjs";
import { runPostPromotionDbFailure } from "./post-promotion-db-failure.mjs";
import { runIntegrityMismatchDetection } from "./integrity-mismatch.mjs";
import { runMaximumProfileConcurrency } from "./maximum-profile-concurrency.mjs";
import { runProviderLockProfile } from "./provider-lock-profile.mjs";
import { runRestoreDrill } from "./restore-drill.mjs";
import { runProviderPortability } from "./portability.mjs";
function bindExecutor(run, { app = true } = {}) {
  return async (input) => {
    const client = app ? createAppClient({
      baseUrl: input.config.baseUrl,
      identity: input.config.uploaderIdentity,
      signal: input.signal,
      correlationId: `${input.runId}-${input.test.id}`,
      // Kurum içi staging SSO vekilinin sentetik kimlik geçidi (yoksa boş).
      proxyToken: input.config.acceptanceProxyToken,
    }) : null;
    return run(client, {
      runId: input.runId,
      config: input.config,
      signal: input.signal,
      writeEvidence: evidenceWriter(input.evidenceDir),
      requestCorrelationId: `${input.runId}-${input.test.id}`,
    });
  };
}

export const executors = {
  "T-01": bindExecutor(runConditionalWriteProtection, { app: false }),
  "K-1": bindExecutor(runMimeMismatch),
  "K-2": bindExecutor(runEicarQuarantine),
  "K-3": bindExecutor(runMultipartResume),
  "K-7": bindExecutor(runDuplicateSha),
  "T-02": bindExecutor(runPostWriteShaVerification),
  "T-03": bindExecutor(runDerivativeIntegrity),
  "T-04": bindExecutor(runNoStorageKeyDisclosure),
  "T-05": bindExecutor(runExpiredViewTicket),
  "T-06": bindExecutor(runOriginalIamSeparation),
  "T-07": bindExecutor(runProviderLockProfile, { app: false }),
  "T-09": bindExecutor(runRestoreDrill),
  "T-10": bindExecutor(runProviderPortability),
  "K-4": bindExecutor(runQuarantineIamSeparation),
  "T-12": bindExecutor(runBidirectionalReconciliation),
  "T-11": bindExecutor(runPersonalDataSurfaceScan),
  "K-5": bindExecutor(runPostPromotionDbFailure),
  "T-08": bindExecutor(runIntegrityMismatchDetection),
  "K-6": bindExecutor(runMaximumProfileConcurrency),
};

export {
  ExecutorConfigError,
  runMimeMismatch,
  runEicarQuarantine,
  runMultipartResume,
  runDuplicateSha,
  runPostWriteShaVerification,
  runNoStorageKeyDisclosure,
  runDerivativeIntegrity,
  runExpiredViewTicket,
  runBidirectionalReconciliation,
  runConditionalWriteProtection,
  runOriginalIamSeparation,
  runQuarantineIamSeparation,
  runPersonalDataSurfaceScan,
  runPostPromotionDbFailure,
  runIntegrityMismatchDetection,
  runMaximumProfileConcurrency,
  runProviderLockProfile,
  runRestoreDrill,
  runProviderPortability,
};
