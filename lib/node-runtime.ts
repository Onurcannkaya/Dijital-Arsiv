/**
 * Kurum içi port P4 — Node çalışma zamanı önyüklemesi.
 *
 * SQLite veritabanını (P2) ve MinIO/S3 rol paketlerini (P3) bağlama dikişine
 * (P1) kaydeder. Workers'taki `workers-runtime.ts` önyüklemesinin Node
 * eşdeğeridir; sunucu girişi (`server/main.ts`) süreç başında bir kez çağırır.
 *
 * Ortam değişkenleri:
 *   ARCHIVE_DB_PATH                 SQLite dosya yolu (vars. data/arsiv.db)
 *   ARCHIVE_S3_ENDPOINT             HTTPS MinIO/S3 ucu (zorunlu)
 *   ARCHIVE_S3_REGION               vars. "auto"
 *   ARCHIVE_S3_ACCESS_KEY_ID/_SECRET_ACCESS_KEY[/_SESSION_TOKEN]
 *   ARCHIVE_S3_BUCKET_ARCHIVE       asıl kasa kovası (zorunlu)
 *   ARCHIVE_S3_BUCKET_DERIVATIVE / _TEMPORARY / _QUARANTINE (rol gerektirdikçe)
 * Servis/uygulama yapılandırması (OCR_SERVICE_URL, ARCHIVE_ADMIN_EMAILS,
 * ARCHIVE_MIGRATION_TOKEN, APP_ENV, ...) `createNodeEnvBindingsProvider`
 * üzerinden aynı adlarla process.env'den okunur.
 */

import {
  createNodeEnvBindingsProvider,
  setArchiveBindingsProvider,
  type NodeRuntimeAdapters,
} from "./archive-bindings.ts";
import { join } from "node:path";

import { createLocalFsNamespace } from "./local-fs-object-storage.ts";
import { createNodeSqliteD1, type NodeSqliteD1 } from "./node-sqlite-d1.ts";
import {
  NodeS3DispositionStorage,
  NodeS3ImmutableVaultWriter,
  NodeS3ObjectReader,
  NodeS3StagingStorage,
  NodeS3StorageInventory,
  type NodeS3Config,
} from "./node-s3-object-storage.ts";
import {
  RoleBackedObjectStorage,
  makeStorageNamespace,
  type StorageNamespaceHandle,
} from "./storage-roles.ts";

export type NodeRuntimeOptions = {
  env?: Record<string, string | undefined>;
  /** Test enjeksiyonu: S3 istekleri bu fetch üzerinden gider. */
  fetcher?: typeof fetch;
  /** Test enjeksiyonu: ortamdaki yol yerine bu veritabanı yolu kullanılır. */
  dbPath?: string;
};

export type NodeRuntime = {
  db: NodeSqliteD1;
  close(): void;
};

/** Kovaya özel S3 yapılandırmasından tam rol paketi üretir. */
export function createNodeS3Namespace(config: NodeS3Config): StorageNamespaceHandle {
  const reader = new NodeS3ObjectReader(config);
  const staging = new NodeS3StagingStorage(config);
  const inventory = new NodeS3StorageInventory(config);
  return makeStorageNamespace({
    reader,
    staging,
    inventory,
    disposition: new NodeS3DispositionStorage(config),
    objectStorage: new RoleBackedObjectStorage(reader, staging, inventory),
    vaultWriter: (stagingReader) => new NodeS3ImmutableVaultWriter(config, stagingReader),
  });
}

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Node çalışma zamanı için ${name} zorunludur.`);
  return value;
}

/**
 * Bağlama sağlayıcısını kaydeder ve veritabanı tutamacını döndürür. Süreç
 * kapanışında `close()` çağrılmalıdır (WAL checkpoint + bağlantı kapanışı).
 */
export function bootstrapNodeRuntime(options: NodeRuntimeOptions = {}): NodeRuntime {
  const env = options.env ?? process.env;
  const db = createNodeSqliteD1({ path: options.dbPath ?? env.ARCHIVE_DB_PATH ?? "data/arsiv.db" });

  // Lokal geliştirme sürücüsü: MinIO/S3 yerine yerel disk. YALNIZ dev/deneme;
  // kabul kanıtı ve üretim daima S3/MinIO sürücüsünü kullanır.
  if (env.ARCHIVE_STORAGE_DRIVER === "local") {
    const root = env.ARCHIVE_LOCAL_STORAGE_DIR?.trim() || "data/storage";
    const namespaceFor = (bucket: string | undefined) => {
      const name = bucket?.trim();
      return name ? createLocalFsNamespace(join(root, name)) : undefined;
    };
    const adapters: NodeRuntimeAdapters = {
      db,
      archiveFiles: createLocalFsNamespace(join(root, env.ARCHIVE_S3_BUCKET_ARCHIVE?.trim() || "arsiv-asil")),
      derivativeFiles: namespaceFor(env.ARCHIVE_S3_BUCKET_DERIVATIVE || "arsiv-turev"),
      temporaryFiles: namespaceFor(env.ARCHIVE_S3_BUCKET_TEMPORARY || "arsiv-gecici"),
      quarantineFiles: namespaceFor(env.ARCHIVE_S3_BUCKET_QUARANTINE || "arsiv-karantina"),
      // Yedek hedefi bilinçlidir: varsayılan ad verilmez, tanımsızsa kapalıdır.
      backupFiles: namespaceFor(env.ARCHIVE_S3_BUCKET_BACKUP),
    };
    setArchiveBindingsProvider(createNodeEnvBindingsProvider(adapters, env));
    return { db, close() { setArchiveBindingsProvider(null); db.close(); } };
  }

  const s3Base = {
    endpoint: requireEnv(env, "ARCHIVE_S3_ENDPOINT"),
    // Yalnız izole konteyner ağı içindeki MinIO için düz HTTP'ye açık izin.
    allowHttp: env.ARCHIVE_S3_ALLOW_HTTP === "enabled",
    region: env.ARCHIVE_S3_REGION || "auto",
    credentials: {
      accessKeyId: requireEnv(env, "ARCHIVE_S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv(env, "ARCHIVE_S3_SECRET_ACCESS_KEY"),
      sessionToken: env.ARCHIVE_S3_SESSION_TOKEN?.trim() || undefined,
    },
    fetcher: options.fetcher,
  };
  const namespaceFor = (bucket: string | undefined) => {
    const name = bucket?.trim();
    return name ? createNodeS3Namespace({ ...s3Base, bucket: name }) : undefined;
  };

  /*
   * ADR-017: yedek hedefi ikinci hata alanında ve ayrı yönetim kimliğinde
   * olmalıdır. Bu yüzden yedek kovası kendi ucunu/kimliğini alabilir; verilmeyen
   * her değer birincile düşer ama uç ve kimlik birincille aynıysa "ikinci hata
   * alanı" şartı KARŞILANMAMIŞTIR — bu bir kod kararı değil kurulum kararıdır
   * ve işletim rehberine yazılır.
   */
  const backupBucket = env.ARCHIVE_S3_BUCKET_BACKUP?.trim();
  const backupFiles = backupBucket ? createNodeS3Namespace({
    endpoint: env.ARCHIVE_BACKUP_S3_ENDPOINT?.trim() || s3Base.endpoint,
    allowHttp: env.ARCHIVE_BACKUP_S3_ALLOW_HTTP === "enabled" || s3Base.allowHttp,
    region: env.ARCHIVE_BACKUP_S3_REGION?.trim() || s3Base.region,
    credentials: env.ARCHIVE_BACKUP_S3_ACCESS_KEY_ID?.trim() ? {
      accessKeyId: requireEnv(env, "ARCHIVE_BACKUP_S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv(env, "ARCHIVE_BACKUP_S3_SECRET_ACCESS_KEY"),
      sessionToken: env.ARCHIVE_BACKUP_S3_SESSION_TOKEN?.trim() || undefined,
    } : s3Base.credentials,
    fetcher: options.fetcher,
    bucket: backupBucket,
  }) : undefined;

  const adapters: NodeRuntimeAdapters = {
    db,
    archiveFiles: createNodeS3Namespace({
      ...s3Base,
      bucket: requireEnv(env, "ARCHIVE_S3_BUCKET_ARCHIVE"),
    }),
    derivativeFiles: namespaceFor(env.ARCHIVE_S3_BUCKET_DERIVATIVE),
    temporaryFiles: namespaceFor(env.ARCHIVE_S3_BUCKET_TEMPORARY),
    quarantineFiles: namespaceFor(env.ARCHIVE_S3_BUCKET_QUARANTINE),
    backupFiles,
  };
  setArchiveBindingsProvider(createNodeEnvBindingsProvider(adapters, env));

  return {
    db,
    close() {
      setArchiveBindingsProvider(null);
      db.close();
    },
  };
}
