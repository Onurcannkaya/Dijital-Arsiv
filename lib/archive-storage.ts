// Çalışma zamanı önyüklemesi: Workers ortamını bağlama dikişine kaydeder.
// Kurum içi Node build'i bu importu Node önyüklemesiyle takas eder (P1/P4).
import "./workers-runtime.ts";

import { resolveArchiveBindings, type ArchiveBindings } from "./archive-bindings.ts";
import type { ObjectStorage } from "./object-storage.ts";
import {
  storageObjectStorage, storageReader, storageStaging, storageVaultWriter,
} from "./storage-roles.ts";

export {
  ARCHIVE_SCHEMA_VERSION, applyArchiveMigrations, assertSchemaReady,
  readMaintenanceProgress, readSchemaVersion, requireArchiveSchema,
  runMaintenanceSlice, SchemaNotReadyError, SEARCH_REINDEX_TASK,
} from "./archive-schema";
export { jsonError } from "./http.ts";
export {
  resolveOriginalObject, resolveViewableObject,
  type ResolvedObject, type StoredObject,
} from "./binary-objects.ts";
export {
  ObjectStorageError, isObjectStorageError,
  type ObjectStorage, type ObjectStorageBody, type ObjectStorageHead,
  type ObjectStoragePutOptions, type ObjectStorageValue,
  type ObjectReader, type StagingStorage, type ImmutableVaultWriter,
  type StorageInventory, type DispositionStorage,
  type ObjectStat, type ObjectBody, type PutObjectOptions, type ByteRange,
  type MultipartUploadToken, type UploadedPart, type StorageErrorCode,
} from "./object-storage.ts";
export {
  createObjectStorage, R2ObjectStorage,
  R2ObjectReader, R2StagingStorage, R2ImmutableVaultWriter,
  R2StorageInventory, R2DispositionStorage,
} from "./r2-object-storage.ts";
export { createDigestStreamHasher, type StreamingHasher, type StreamDigest } from "./content-hasher.ts";
export { INTEGRITY_SCAN_TASK, readIntegrityProgress, readIntegritySummary, runIntegritySlice } from "./integrity.ts";
export {
  RECONCILIATION_TASK, readReconciliationSummary, runReconciliationSlice,
  type ReconciliationDependencies,
} from "./reconciliation.ts";
export { processNextDerivativeJob, readDerivativeSummary } from "./document-render.ts";
export {
  KEY_INVENTORY_TASK, processNextKeyMigrationJob, readKeyMigrationSummary,
  runKeyInventorySlice, type KeyMigrationDependencies,
} from "./key-migration.ts";
export { classifyObjectKey, maskObjectKey, secureTargetKey } from "./key-classification.ts";
export {
  MAX_PORTABLE_MANIFEST_BYTES, PORTABLE_PACKAGE_VERSION,
  buildPortableManifest, canonicalJson, exportPortablePackage, manifestDigest,
  restorePortablePackage, validatePortableManifest, verifyAuditChain,
  verifyAuditLinkage, verifyPortablePackage,
  type PortableManifest, type RestorePortableOptions, type RestoreStorageTarget,
  type VerifyPortableOptions,
} from "./storage-manifest.ts";
export {
  ACCESS_SESSION_ABSOLUTE_MS, ACCESS_SESSION_IDLE_MS, ACCESS_TICKET_TTL_SECONDS,
  AccessTicketError, consumeDownloadTicket, exchangeViewTicket, issueAccessTicket,
  purposeForScope, revokeViewSession, touchViewSession,
  type AccessPurpose, type AccessScope, type ViewSession,
} from "./access-tickets.ts";
export { isPendingDerivative, type PendingDerivative } from "./binary-objects.ts";

// Bağlama tipi ve Node sağlayıcı fabrikası dikiş modülünde yaşar; tüketiciler
// için buradan yeniden dışa aktarılır (kurum içi port P1).
export {
  createNodeEnvBindingsProvider, setArchiveBindingsProvider,
  type ArchiveBindings, type ArchiveBindingsProvider, type NodeRuntimeAdapters,
} from "./archive-bindings.ts";

/** S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5 nesne sınıfları. */
export type ObjectClass = "original" | "access" | "ocr" | "preservation" | "thumbnail" | "quarantine" | "temporary";

export function getArchiveBindings(): ArchiveBindings {
  return resolveArchiveBindings();
}

/** F1.3 yükleme rolü yalnız geçici ve karantina yetki alanlarını alır. */
export function getIngestStorages(bindings: Pick<ArchiveBindings, "TEMPORARY_FILES" | "QUARANTINE_FILES">) {
  if (!bindings.TEMPORARY_FILES || !bindings.QUARANTINE_FILES) {
    throw new Error("TEMPORARY_FILES ve QUARANTINE_FILES fiziksel depolama bağları yapılandırılmalıdır.");
  }
  return {
    temporary: storageStaging(bindings.TEMPORARY_FILES),
    quarantine: storageStaging(bindings.QUARANTINE_FILES),
  };
}
/** Çalışma zamanı nesne kasasını ADR-012 arayüzüne dönüştürür. */
export function getArchiveObjectStorage(bindings: Pick<ArchiveBindings, "ARCHIVE_FILES">): ObjectStorage {
  return storageObjectStorage(bindings.ARCHIVE_FILES);
}

/** Yetkili kayıttaki namespace'i dar okuma rolüne çevirir; bilinmeyen alan fail-closed'dur. */
export function getObjectReaderForNamespace(
  bindings: Pick<ArchiveBindings, "ARCHIVE_FILES" | "DERIVATIVE_FILES">,
  namespace: string,
) {
  if (namespace === "ARCHIVE_FILES") return storageReader(bindings.ARCHIVE_FILES);
  if (namespace === "DERIVATIVE_FILES" && bindings.DERIVATIVE_FILES) {
    return storageReader(bindings.DERIVATIVE_FILES);
  }
  throw new Error(`Depolama okuma rolü yapılandırılmamış: ${namespace}`);
}

/** VIEW yolu yalnız türev kovasının dar okuma rolünü alabilir. */
export function getDerivativeViewReader(
  bindings: Pick<ArchiveBindings, "DERIVATIVE_FILES">,
) {
  if (!bindings.DERIVATIVE_FILES) throw new Error("DERIVATIVE_FILES görüntüleme rolü yapılandırılmamış.");
  return storageReader(bindings.DERIVATIVE_FILES);
}

/** DOWNLOAD yolu yalnız asıl kovanın dar okuma rolünü alabilir. */
export function getOriginalDownloadReader(
  bindings: Pick<ArchiveBindings, "ARCHIVE_FILES">,
) {
  return storageReader(bindings.ARCHIVE_FILES);
}

/** F1.5 promotion role: quarantine read, immutable vault write, and vault read-back. */
export function getPromotionStorages(
  bindings: Pick<ArchiveBindings, "ARCHIVE_FILES" | "QUARANTINE_FILES">,
) {
  if (!bindings.QUARANTINE_FILES) {
    throw new Error("QUARANTINE_FILES must be configured for promotion.");
  }
  const quarantineReader = storageReader(bindings.QUARANTINE_FILES);
  return {
    quarantineReader,
    vaultReader: storageReader(bindings.ARCHIVE_FILES),
    vaultWriter: storageVaultWriter(bindings.ARCHIVE_FILES, quarantineReader),
  };
}

export function localContentScanServiceUrl(request: Request, configured?: string) {
  if (configured) return configured.replace(/\/$/, "");
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "http://127.0.0.1:8091" : null;
}

export function localOcrServiceUrl(request: Request, configured?: string) {
  if (configured) return configured.replace(/\/$/, "");
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "http://127.0.0.1:8090" : null;
}
