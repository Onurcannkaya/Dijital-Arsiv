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

import type { StorageBinding } from "./storage-roles.ts";

export type ArchiveBindings = {
  DB: D1Database;
  ARCHIVE_FILES: StorageBinding;
  DERIVATIVE_FILES?: StorageBinding;
  TEMPORARY_FILES?: StorageBinding;
  QUARANTINE_FILES?: StorageBinding;
  /**
   * ADR-017 yedek hedefi. Tanımlıysa yedek dilimleri çalışır; değilse yedekleme
   * "yapılandırılmadı" olarak ölçülür. İkinci hata alanı ve ayrı yönetim
   * kimliği ADR şartıdır — Node yapılandırması ayrı uç/kimlik destekler
   * (ARCHIVE_BACKUP_S3_*); aynı MinIO'ya aynı kimlikle yazmak bu şartı
   * karşılamaz ve işletim rehberinde açıkça söylenir.
   */
  BACKUP_FILES?: StorageBinding;
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
  /** Kurum içi imajın değişmez commit etiketi; readiness kanıtına yansır. */
  ARCHIVE_RELEASE_REVISION?: string;
  /** Yalnız staging kabul kanıtı okuma uç noktasının ayrı, en-dar yetki anahtarıdır. */
  ARCHIVE_ACCEPTANCE_TOKEN?: string;
  /**
   * YALNIZ YEREL GELİŞTİRME: "enabled" iken /api/internal/objects ucu açılır ve
   * Python servisleri nesneleri S3 yerine uygulamadan indirir. Üretimde ve kabul
   * koşusunda tanımlanmaz — servisler MinIO'ya salt-okunur kimlikle doğrudan
   * bağlanır (ADR-014); bu bayrak dağıtım yapılandırmalarına asla girmez.
   */
  ARCHIVE_INTERNAL_OBJECT_FETCH?: string;
  /**
   * Alarm taşıyıcısı: tanımlıysa kritik işletim olayları (bütünlük bulgusu,
   * dead-letter artışı, yedek arızası) bu uca JSON POST edilir. Tanımlı
   * değilse olaylar yalnız yapılandırılmış log'da kalır — bu durum gizlenmez.
   */
  ALARM_WEBHOOK_URL?: string;
  ALARM_WEBHOOK_TOKEN?: string;
  /**
   * Depolama kapasite kotası, GB cinsinden (İş Etki Analizi kararına bağlanır).
   * Tanımlıysa pano doluluk oranını gösterir ve eşik aşımında alarm gider;
   * tanımlı değilse kota "tanımlı değil" olarak raporlanır — kullanım her
   * durumda ölçülür, yalnız tavan kurum kararıdır.
   */
  ARCHIVE_STORAGE_QUOTA_GB?: string;
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
  archiveFiles: StorageBinding;
  derivativeFiles?: StorageBinding;
  temporaryFiles?: StorageBinding;
  quarantineFiles?: StorageBinding;
  backupFiles?: StorageBinding;
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
  "ARCHIVE_RELEASE_REVISION",
  "ARCHIVE_ACCEPTANCE_TOKEN",
  "ARCHIVE_INTERNAL_OBJECT_FETCH",
  "ALARM_WEBHOOK_URL",
  "ALARM_WEBHOOK_TOKEN",
  "ARCHIVE_STORAGE_QUOTA_GB",
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
      BACKUP_FILES: adapters.backupFiles,
    };
    for (const key of NODE_CONFIG_KEYS) {
      const value = env[key]?.trim();
      if (value) bindings[key] = value;
    }
    return bindings;
  };
}
