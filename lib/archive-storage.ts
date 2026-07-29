import { env } from "cloudflare:workers";

export { ensureArchiveSchema, ARCHIVE_SCHEMA_VERSION } from "./archive-schema";

export type ArchiveBindings = {
  DB: D1Database;
  ARCHIVE_FILES: R2Bucket;
  OCR_SERVICE_URL?: string;
  OCR_SERVICE_TOKEN?: string;
  ARCHIVE_ADMIN_EMAILS?: string;
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

export function localOcrServiceUrl(request: Request, configured?: string) {
  if (configured) return configured.replace(/\/$/, "");
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "http://127.0.0.1:8090" : null;
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

type OriginalObject = { object_key: string; media_type: string; byte_size: number; sha256: string };

/**
 * Belgenin asıl nesnesini `binary_objects` üzerinden çözer.
 *
 * Nesne kaydı yetkili listedir; `archive_documents` kolonları kabul alındısı
 * olarak yalnız geri dönüş yolu sağlar (geçmiş kayıtlar için).
 */
export async function resolveOriginalObject(db: D1Database, documentId: string): Promise<OriginalObject | null> {
  const object = await db.prepare(`SELECT object_key, media_type, byte_size, sha256 FROM binary_objects
    WHERE document_id = ? AND object_class = 'original' LIMIT 1`).bind(documentId).first<OriginalObject>();
  if (object) return object;
  return await db.prepare(`SELECT storage_key AS object_key, media_type, byte_size, sha256
    FROM archive_documents WHERE id = ?`).bind(documentId).first<OriginalObject>();
}
