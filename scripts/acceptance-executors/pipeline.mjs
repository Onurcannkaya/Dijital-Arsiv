/**
 * F1.11 — Kabul hattı canlı yürütücüleri (dikey dilim: K-1, K-2, K-3, K-7, T-02).
 *
 * Her yürütücü gerçek staging uygulamasını HTTP üzerinden sürer ve sonucu
 * fiziksel JSON kanıtla döndürür. Bu modül `ACCEPTANCE_EXECUTOR_MODULE` ile
 * yalnız scripts/acceptance-executors altından yüklenir. Beş test birlikte
 * API → karantina → tarama → terfi → değişmez asıl zincirini uçtan uca kanıtlar.
 */

import { ExecutorConfigError, createAppClient, evidenceWriter } from "./contract.mjs";
import { runMimeMismatch } from "./mime-mismatch.mjs";
import { runEicarQuarantine } from "./eicar-quarantine.mjs";
import { runMultipartResume } from "./multipart-resume.mjs";
import { runDuplicateSha } from "./duplicate-sha.mjs";
import { runPostWriteShaVerification } from "./post-write-sha.mjs";

/** Koşu betiğinin yürütücü sözleşmesini (contract.mjs başlığı) tek noktadan bağlar. */
function bindExecutor(run) {
  return async (input) => {
    const client = createAppClient({
      baseUrl: input.config.baseUrl,
      identity: input.config.uploaderIdentity,
      signal: input.signal,
    });
    return run(client, {
      runId: input.runId,
      config: input.config,
      signal: input.signal,
      writeEvidence: evidenceWriter(input.evidenceDir),
    });
  };
}

export const executors = {
  "K-1": bindExecutor(runMimeMismatch),
  "K-2": bindExecutor(runEicarQuarantine),
  "K-3": bindExecutor(runMultipartResume),
  "K-7": bindExecutor(runDuplicateSha),
  "T-02": bindExecutor(runPostWriteShaVerification),
};

export {
  ExecutorConfigError,
  runMimeMismatch,
  runEicarQuarantine,
  runMultipartResume,
  runDuplicateSha,
  runPostWriteShaVerification,
};
