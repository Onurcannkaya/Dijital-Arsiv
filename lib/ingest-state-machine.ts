/**
 * Faz 1 kabul hattı durum sözleşmesi.
 *
 * Bu modül depolama sağlayıcısından ve HTTP katmanından bağımsızdır. Kalıcı durum
 * güncellemesi yapan servis, önce bu kuralları doğrular; ardından
 * `state_version` üzerinde iyimser eşzamanlılık denetimiyle tek SQL güncellemesi
 * yapar.
 */

export const INGEST_SESSION_STATUSES = [
  "CREATED",
  "UPLOADING",
  "QUARANTINED",
  "SCANNING",
  "VERIFIED",
  "PROMOTING",
  "ACCEPTED",
  "REJECTED",
  "DUPLICATE",
  "EXPIRED",
  "FAILED",
] as const;

export type IngestSessionStatus = typeof INGEST_SESSION_STATUSES[number];

export const TERMINAL_INGEST_STATUSES = [
  "ACCEPTED",
  "REJECTED",
  "DUPLICATE",
  "EXPIRED",
] as const satisfies readonly IngestSessionStatus[];

const ordinaryTransitions: Readonly<Record<IngestSessionStatus, readonly IngestSessionStatus[]>> = {
  CREATED: ["UPLOADING", "EXPIRED"],
  UPLOADING: ["QUARANTINED", "EXPIRED", "FAILED"],
  QUARANTINED: ["SCANNING", "EXPIRED", "FAILED"],
  SCANNING: ["VERIFIED", "REJECTED", "FAILED"],
  VERIFIED: ["PROMOTING", "DUPLICATE", "EXPIRED"],
  PROMOTING: ["ACCEPTED", "FAILED"],
  ACCEPTED: [],
  REJECTED: [],
  DUPLICATE: [],
  EXPIRED: [],
  FAILED: [],
};

export type OperatorRetryEvidence = {
  actorKind: "operator" | "user" | "service";
  actorId: string;
  reason: string;
  quarantineObjectAvailable: boolean;
  verifiedReceiptAvailable: boolean;
  retryWindowOpen: boolean;
};

export type TransitionDecision =
  | { allowed: true; operatorRetry: boolean }
  | { allowed: false; code: "INVALID_TRANSITION" | "OPERATOR_RETRY_REQUIRED"; reason: string };

/**
 * Aynı duruma yeniden yazma, komut tekrarlarında yan etkisiz kabul edilir.
 * `FAILED -> PROMOTING` yalnız kanıtlı ve denetlenebilir operatör yeniden
 * denemesidir; normal geçiş tablosuna bilerek eklenmemiştir.
 */
export function decideIngestTransition(
  from: IngestSessionStatus,
  to: IngestSessionStatus,
  retry?: OperatorRetryEvidence,
): TransitionDecision {
  if (from === to) return { allowed: true, operatorRetry: false };

  if (from === "FAILED" && to === "PROMOTING") {
    const valid = retry?.actorKind === "operator"
      && retry.actorId.trim().length > 0
      && retry.reason.trim().length > 0
      && retry.quarantineObjectAvailable
      && retry.verifiedReceiptAvailable
      && retry.retryWindowOpen;
    return valid
      ? { allowed: true, operatorRetry: true }
      : {
          allowed: false,
          code: "OPERATOR_RETRY_REQUIRED",
          reason: "FAILED durumundan terfi yalnız geçerli karantina nesnesi ve doğrulama alındısıyla yetkili operatör tarafından yinelenebilir.",
        };
  }

  if (ordinaryTransitions[from].includes(to)) return { allowed: true, operatorRetry: false };
  return {
    allowed: false,
    code: "INVALID_TRANSITION",
    reason: `${from} durumundan ${to} durumuna geçiş kabul sözleşmesinde tanımlı değil.`,
  };
}

export function isTerminalIngestStatus(status: IngestSessionStatus) {
  return (TERMINAL_INGEST_STATUSES as readonly IngestSessionStatus[]).includes(status);
}
