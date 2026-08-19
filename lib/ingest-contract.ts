import {
  INGEST_SESSION_STATUSES,
  type IngestSessionStatus,
  type OperatorRetryEvidence,
  decideIngestTransition,
} from "./ingest-state-machine.ts";

export const MAX_INGEST_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_MULTIPART_PARTS = 10_000;

/**
 * ADR-013 / ADR-014: FAILED terfinin karantina nesnesi "yetkili yeniden
 * deneme penceresi için 7 gün" tutulur; pencere dolduğunda kurtarma kapanır
 * ve memurun yeni oturum açması gerekir. Süre karantina yaşam döngüsüyle
 * AYNI kaynaktan gelmelidir — pencere burada uzatılıp temizlik 7 günde
 * silmeye devam ederse operatör var olmayan nesneye yeniden deneme başlatır.
 */
export const OPERATOR_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** FAILED anından bu yana geçen süre pencereyi aşmadıysa kurtarma açıktır. */
export function isOperatorRetryWindowOpen(failedAtIso: string, now: Date): boolean {
  const failedAt = new Date(failedAtIso.includes("T") ? failedAtIso : `${failedAtIso.replace(" ", "T")}Z`);
  if (Number.isNaN(failedAt.getTime())) return false;
  return now.getTime() - failedAt.getTime() <= OPERATOR_RETRY_WINDOW_MS;
}

/**
 * Kabul edilen belge biçimleri — tek tanım.
 *
 * İçeriğe bakan asıl denetim tarama servisindedir
 * (`services/content-scan/app/file_validation.py`): bildirilen tür ile
 * dosyanın gerçek sihirli baytları orada karşılaştırılır ve K-1 kabul testi
 * bunu kanıtlar. Ama bildirilen türün hiç desteklenmediği durum oturum
 * açılırken bilinebilir; kabul edilirse memur 2 GiB'a kadar dosyayı boşuna
 * yükler, baytlar karantina deposunu işgal eder ve ret ancak taramada gelir.
 *
 * Uzantı listesi arayüzdeki dosya seçicisini besler; MIME listesiyle birlikte
 * burada durur ki ikisi ayrışmasın.
 */
export const ACCEPTED_MEDIA_TYPES: Record<string, readonly string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/tiff": [".tif", ".tiff"],
};

export const ACCEPTED_FILE_EXTENSIONS = Object.values(ACCEPTED_MEDIA_TYPES).flat();

export function isAcceptedMediaType(value: string): boolean {
  return Object.hasOwn(ACCEPTED_MEDIA_TYPES, value.trim().toLowerCase());
}

export type IngestSessionRecord = {
  id: string;
  tenantId: string;
  userId: string;
  unit: string;
  idempotencyKey: string;
  status: IngestSessionStatus;
  stateVersion: number;
  expectedByteSize: number;
  uploadedByteSize: number;
  declaredMediaType: string;
  detectedMediaType: string | null;
  duplicateOfDocumentId: string | null;
  expiresAt: string;
};

export type IngestStateUpdate = {
  sessionId: string;
  expectedStateVersion: number;
  from: IngestSessionStatus;
  to: IngestSessionStatus;
  retry?: OperatorRetryEvidence;
};

export class IngestContractError extends Error {
  readonly code: "INVALID_STATUS" | "INVALID_SIZE" | "INVALID_STATE_TRANSITION";

  constructor(
    code: "INVALID_STATUS" | "INVALID_SIZE" | "INVALID_STATE_TRANSITION",
    message: string,
  ) {
    super(message);
    this.name = "IngestContractError";
    this.code = code;
  }
}

export function assertIngestSize(byteSize: number) {
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_INGEST_BYTES) {
    throw new IngestContractError(
      "INVALID_SIZE",
      `Belge boyutu 1 ile ${MAX_INGEST_BYTES} bayt arasında olmalıdır.`,
    );
  }
}

export type VerifiedIngestDecision =
  | {
      status: "DUPLICATE";
      duplicateOfDocumentId: string;
      createDocument: false;
      createOriginal: false;
      enqueueOcr: false;
    }
  | {
      status: "PROMOTING";
      duplicateOfDocumentId: null;
      createDocument: true;
      createOriginal: true;
      enqueueOcr: true;
    };

/**
 * Sunucuda hesaplanan SHA-256 eşleşmesi, belge üretmeden terminal DUPLICATE
 * sonucuna gider. F1.3/F1.5 orkestrasyonu bu kararı tek işlem içinde uygular.
 */
export function decideVerifiedIngest(existingDocumentId: string | null): VerifiedIngestDecision {
  if (existingDocumentId) {
    return {
      status: "DUPLICATE",
      duplicateOfDocumentId: existingDocumentId,
      createDocument: false,
      createOriginal: false,
      enqueueOcr: false,
    };
  }
  return {
    status: "PROMOTING",
    duplicateOfDocumentId: null,
    createDocument: true,
    createOriginal: true,
    enqueueOcr: true,
  };
}
export function assertIngestStatus(value: string): asserts value is IngestSessionStatus {
  if (!(INGEST_SESSION_STATUSES as readonly string[]).includes(value)) {
    throw new IngestContractError("INVALID_STATUS", `Bilinmeyen kabul durumu: ${value}`);
  }
}

/**
 * SQL yazıcısının kullanacağı iyimser eşzamanlılık girdisini doğrular.
 * Güncelleme sorgusu `WHERE id = ? AND status = ? AND state_version = ?`
 * koşulunu uygulamalı ve etkilenen satır sayısını tam olarak 1 beklemelidir.
 */
export function assertIngestStateUpdate(update: IngestStateUpdate) {
  if (!Number.isSafeInteger(update.expectedStateVersion) || update.expectedStateVersion < 0) {
    throw new IngestContractError("INVALID_STATE_TRANSITION", "Geçersiz durum sürümü.");
  }
  const decision = decideIngestTransition(update.from, update.to, update.retry);
  if (!decision.allowed) {
    throw new IngestContractError("INVALID_STATE_TRANSITION", decision.reason);
  }
  return decision;
}
