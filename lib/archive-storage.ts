import { env } from "cloudflare:workers";
import type { ObjectStorage } from "./object-storage.ts";
import { createObjectStorage } from "./r2-object-storage.ts";

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
export { INTEGRITY_SCAN_TASK, readIntegrityProgress, runIntegritySlice } from "./integrity.ts";

export type ArchiveBindings = {
  DB: D1Database;
  ARCHIVE_FILES: R2Bucket;
  OCR_SERVICE_URL?: string;
  OCR_SERVICE_TOKEN?: string;
  ARCHIVE_ADMIN_EMAILS?: string;
  /** Şema göç uç noktasının anahtarı; tanımlı değilse uç nokta kapalıdır. */
  ARCHIVE_MIGRATION_TOKEN?: string;
};

/** S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5 nesne sınıfları. */
export type ObjectClass = "original" | "access" | "ocr" | "preservation" | "thumbnail" | "quarantine" | "temporary";

export function getArchiveBindings(): ArchiveBindings {
  const bindings = env as unknown as Partial<ArchiveBindings>;
  if (!bindings.DB || !bindings.ARCHIVE_FILES) {
    throw new Error("Arşiv veritabanı veya dosya kasası bağlaması kullanılamıyor.");
  }
  return bindings as ArchiveBindings;
}

/** Çalışma zamanı nesne kasasını ADR-012 arayüzüne dönüştürür. */
export function getArchiveObjectStorage(bindings: Pick<ArchiveBindings, "ARCHIVE_FILES">): ObjectStorage {
  return createObjectStorage(bindings.ARCHIVE_FILES);
}

export function localOcrServiceUrl(request: Request, configured?: string) {
  if (configured) return configured.replace(/\/$/, "");
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "http://127.0.0.1:8090" : null;
}
