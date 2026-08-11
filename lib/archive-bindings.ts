/**
 * Çalışma zamanından bağımsız arşiv bağlama dikişi (kurum içi port P1,
 * KURUM_ICI_PORT_KAPSAMI.md).
 *
 * Depolama katmanının hangi çalışma zamanından beslendiği yalnız buradaki
 * sağlayıcı kaydıyla belirlenir:
 *
 * - Workers (pilot): `lib/workers-runtime.ts` modül yüklenirken
 *   `cloudflare:workers` ortamını kaydeder; davranış birebir korunur.
 * - Node (kurum içi): önyükleme kodu `createNodeEnvBindingsProvider` ile
 *   process.env yapılandırmasını ve enjekte edilen veritabanı/nesne kasası
 *   adaptörlerini (P2/P3) kaydeder.
 *
 * Tüketiciler `archive-storage.ts` üzerinden çalışmaya devam eder; bu modül
 * `cloudflare:workers` dahil hiçbir çalışma zamanı modülünü içe aktarmaz ve
 * Node testlerinde doğrudan yüklenebilir.
 */

export type ArchiveBindings = {
  DB: D1Database;
  ARCHIVE_FILES: R2Bucket;
  DERIVATIVE_FILES?: R2Bucket;
  TEMPORARY_FILES?: R2Bucket;
  QUARANTINE_FILES?: R2Bucket;
  OCR_SERVICE_URL?: string;
  OCR_SERVICE_TOKEN?: string;
  CONTENT_SCAN_SERVICE_URL?: string;
  CONTENT_SCAN_SERVICE_TOKEN?: string;
  DOCUMENT_RENDER_SERVICE_URL?: string;
  DOCUMENT_RENDER_SERVICE_TOKEN?: string;
  DOCUMENT_RENDER_IMAGE_DIGEST?: string;
  ARCHIVE_ADMIN_EMAILS?: string;
  /** Şema göç uç noktasının anahtarı; tanımlı değilse uç nokta kapalıdır. */
  ARCHIVE_MIGRATION_TOKEN?: string;
  APP_ENV?: string;
  /** Yalnız staging kabul kanıtı okuma uç noktasının ayrı, en-dar yetki anahtarıdır. */
  ARCHIVE_ACCEPTANCE_TOKEN?: string;
};

export type ArchiveBindingsProvider = () => Partial<ArchiveBindings>;

let provider: ArchiveBindingsProvider | null = null;

/** Çalışma zamanı önyüklemesi kaydeder; `null` kaydı (testler için) temizler. */
export function setArchiveBindingsProvider(next: ArchiveBindingsProvider | null) {
  provider = next;
}

export function resolveArchiveBindings(): ArchiveBindings {
  if (!provider) {
    throw new Error(
      "Arşiv bağlama sağlayıcısı kayıtlı değil; çalışma zamanı önyüklemesi "
      + "(workers-runtime ya da Node eşdeğeri) yüklenmeden depolama katmanı kullanılamaz.",
    );
  }
  const bindings = provider();
  if (!bindings.DB || !bindings.ARCHIVE_FILES) {
    throw new Error("Arşiv veritabanı veya dosya kasası bağlaması kullanılamıyor.");
  }
  return bindings as ArchiveBindings;
}

/**
 * Kurum içi Node çalışma zamanının somut adaptörleri. Tipler bugün Workers
 * arayüzlerinin (D1Database/R2Bucket) kullanılan yüzeyini hedefler; P2 (SQLite
 * D1 sarmalayıcısı) ve P3 (MinIO S3 adaptörü) bu yüzeyi karşılayan
 * uygulamaları enjekte eder.
 */
export type NodeRuntimeAdapters = {
  db: D1Database;
  archiveFiles: R2Bucket;
  derivativeFiles?: R2Bucket;
  temporaryFiles?: R2Bucket;
  quarantineFiles?: R2Bucket;
};

const NODE_CONFIG_KEYS = [
  "OCR_SERVICE_URL",
  "OCR_SERVICE_TOKEN",
  "CONTENT_SCAN_SERVICE_URL",
  "CONTENT_SCAN_SERVICE_TOKEN",
  "DOCUMENT_RENDER_SERVICE_URL",
  "DOCUMENT_RENDER_SERVICE_TOKEN",
  "DOCUMENT_RENDER_IMAGE_DIGEST",
  "ARCHIVE_ADMIN_EMAILS",
  "ARCHIVE_MIGRATION_TOKEN",
  "APP_ENV",
  "ARCHIVE_ACCEPTANCE_TOKEN",
] as const;

/**
 * process.env yapılandırması + enjekte adaptörlerden bağlama sağlayıcısı üretir.
 * Ortam değerleri her çözümde yeniden okunur; boş dizeler tanımsız sayılır ki
 * fail-closed denetimler (ör. göç ucu anahtarı) yanlışlıkla açılmasın.
 */
export function createNodeEnvBindingsProvider(
  adapters: NodeRuntimeAdapters,
  env: Record<string, string | undefined> = process.env,
): ArchiveBindingsProvider {
  return () => {
    const bindings: Partial<ArchiveBindings> = {
      DB: adapters.db,
      ARCHIVE_FILES: adapters.archiveFiles,
      DERIVATIVE_FILES: adapters.derivativeFiles,
      TEMPORARY_FILES: adapters.temporaryFiles,
      QUARANTINE_FILES: adapters.quarantineFiles,
    };
    for (const key of NODE_CONFIG_KEYS) {
      const value = env[key]?.trim();
      if (value) bindings[key] = value;
    }
    return bindings;
  };
}
