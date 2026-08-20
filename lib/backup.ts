/**
 * ADR-017 yedekleme dilimleri.
 *
 * Yedekleme ayrı bir cron almaz: bakım turu (`MAINTENANCE_CRON`, 5 dk) her
 * tetikte `runBackupSlice` çağırır ve dilim kendi hızını `backup_runs`
 * defterinden alır. Üç iş türü vardır; tur başına EN FAZLA BİRİ çalışır ki
 * bakım bütçesi taşmasın:
 *
 * - `originals_incremental` (saatlik): kabul edilmiş asıllar ikinci hata
 *   alanına artımlı kopyalanır. İmleç (created_at|id) defterde taşınır;
 *   dilim başına sınırlı nesne kopyalanır, kalan sonraki turda sürer.
 * - `metadata_export` (günlük): bütün uygulama tablolarının kanonik JSON
 *   dökümü. Üst veri, yetki, ilişkiler ve denetim izi TEK kesimde çıkar —
 *   ADR'nin "dosya geri gelse bile bağlam olmadan arşiv geri kazanılmış
 *   sayılmaz" gerekçesinin karşılığı.
 * - `manifest_daily` (günlük): nesne defterinin (binary_objects) kesim
 *   zamanlı manifesti. Sağlayıcı anahtarı manifeste GİRMEZ (ADR-017: anahtar
 *   taşınabilir bütünlük kanıtı değildir); kimlik + SHA-256 + boyut girer.
 *
 * Dürüstlük sınırları (ADR'nin tamamı değildir ve öyleymiş gibi sunulmaz):
 * - Üst veri RPO hedefi 15 dk; bu ilk ayak GÜNLÜK dışa aktarımdır. PITR/15 dk
 *   günlükleme veritabanı katmanının işidir (SQLite WAL kopyası / D1 PITR) ve
 *   ayrı kurulum kararı bekler.
 * - Şifreleme sağlayıcı yönetimlidir (MinIO SSE / R2); uygulama katmanı ayrı
 *   zarf şifrelemesi yapmaz.
 * - "İkinci hata alanı ve ayrı yönetim kimliği" bir KURULUM özelliğidir:
 *   ARCHIVE_BACKUP_S3_* değişkenleri ayrı uç/kimlik almadıkça bu kopya aynı
 *   alanda kalır; kod bunu ölçemez, işletim rehberi söyler.
 */

import type { ArchiveBindings } from "./archive-bindings.ts";
import { SCHEMA_MANIFEST, ARCHIVE_SCHEMA_VERSION } from "./archive-schema.ts";
import { dispatchAlert } from "./alerts.ts";
import { digestToHex } from "./content-hasher.ts";
import { isObjectStorageError } from "./object-storage.ts";
import { logEvent } from "./observability.ts";
import { storageReader, storageVaultWriter } from "./storage-roles.ts";

export const BACKUP_EXPORT_VERSION = "backup-export-v1";
export const INCREMENTAL_INTERVAL_MS = 60 * 60 * 1000;
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** ADR-017 tatbikat maddesi: "Aylık: yedek işi ve manifest tutarlılığı otomatik kontrolü". */
export const CONSISTENCY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
/** Dilim başına kopyalanan asıl nesne; bakım bütçesini korur. */
export const INCREMENTAL_BATCH = 25;
/** Tutarlılık kontrolünün yedekte varlığını doğruladığı asıl örneklem boyutu. */
export const CONSISTENCY_SAMPLE = 20;

type BackupKind = "originals_incremental" | "metadata_export" | "manifest_daily" | "consistency_check";

type LastRun = { completed_at: string | null; cursor: string | null };

async function lastCompleted(db: D1Database, kind: BackupKind): Promise<LastRun | null> {
  return db.prepare(`SELECT completed_at, cursor FROM backup_runs
    WHERE kind = ? AND status = 'COMPLETED'
    ORDER BY completed_at DESC LIMIT 1`).bind(kind).first<LastRun>();
}

function due(last: LastRun | null, intervalMs: number, now: Date) {
  if (!last?.completed_at) return true;
  const at = new Date(last.completed_at).getTime();
  return Number.isNaN(at) || now.getTime() - at >= intervalMs;
}

async function sha256Hex(text: string) {
  const bytes = new TextEncoder().encode(text);
  return { hex: digestToHex(await crypto.subtle.digest("SHA-256", bytes)), byteSize: bytes.byteLength };
}

function stampKey(prefix: string, now: Date) {
  const day = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replaceAll(":", "");
  return `${prefix}/${day}/${time}.json`;
}

async function openRun(db: D1Database, kind: BackupKind, now: Date) {
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO backup_runs (id, kind, status, started_at, created_at)
    VALUES (?, ?, 'RUNNING', ?, ?)`).bind(id, kind, now.toISOString(), now.toISOString()).run();
  return id;
}

async function closeRun(db: D1Database, runId: string, now: Date, patch: {
  status: "COMPLETED" | "FAILED";
  objectKey?: string | null;
  byteSize?: number | null;
  sha256?: string | null;
  copiedCount?: number;
  cursor?: string | null;
  error?: string | null;
}) {
  // Kapanış anı dilimin MANTIKSAL saatiyle yazılır (test enjeksiyonu dahil);
  // duvar saati kullanılsaydı hız denetimi kendi yazdığı kayıtla çelişirdi.
  await db.prepare(`UPDATE backup_runs SET status = ?, object_key = ?, byte_size = ?, sha256 = ?,
      copied_count = ?, cursor = ?, error = ?, completed_at = ? WHERE id = ?`)
    .bind(patch.status, patch.objectKey ?? null, patch.byteSize ?? null, patch.sha256 ?? null,
      patch.copiedCount ?? 0, patch.cursor ?? null, patch.error ?? null,
      now.toISOString(), runId).run();
}

type BackupDependencies = Pick<ArchiveBindings,
  "DB" | "ARCHIVE_FILES" | "BACKUP_FILES" | "ALARM_WEBHOOK_URL" | "ALARM_WEBHOOK_TOKEN" | "APP_ENV">;

/** Asılların ikinci hata alanına artımlı kopyası (ADR-017: en geç saatte bir). */
async function runIncremental(bindings: BackupDependencies, now: Date, previousCursor: string | null) {
  const runId = await openRun(bindings.DB, "originals_incremental", now);
  try {
    const [cursorAt, cursorId] = (previousCursor ?? "|").split("|");
    const batch = await bindings.DB.prepare(`SELECT id, object_key, media_type, sha256, created_at
      FROM binary_objects
      WHERE object_class = 'original'
        AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at, id LIMIT ${INCREMENTAL_BATCH}`)
      .bind(cursorAt, cursorAt, cursorId)
      .all<{ id: string; object_key: string; media_type: string; sha256: string; created_at: string }>();
    const reader = storageReader(bindings.ARCHIVE_FILES);
    const writer = storageVaultWriter(bindings.BACKUP_FILES!, reader);
    let copied = 0;
    let cursor = previousCursor;
    for (const object of batch.results) {
      /*
       * Kopya `promote` ile DEĞİL, oku + if-absent yaz ile yapılır: yerel
       * dosya sürücüsünün promote'u kaynak okuyucuyu yok sayıp kendi ad
       * alanında arıyor (sözleşme ihlali, ayrı düzeltme işi). Okuma+yazma
       * her sürücüde aynı davranır; if-absent koşulu kopyayı idempotent tutar
       * ve yedekteki nesnenin üzerine asla yazılmaz.
       */
      const source = await reader.get(object.object_key);
      if (!source || source.range !== null) {
        throw new Error(`Yedeklenecek asıl nesne kasada okunamadı: ${object.id}`);
      }
      try {
        await writer.putIfAbsent(object.object_key, source.body, {
          contentType: object.media_type,
          contentSha256Hex: object.sha256,
          customMetadata: { sha256: object.sha256, binaryObjectId: object.id, backupOf: "original" },
        });
        copied += 1;
      } catch (error) {
        // Yedekte zaten var: idempotent kopya, ilerleme sayılır.
        if (!isObjectStorageError(error, "KEY_ALREADY_EXISTS")) throw error;
        await source.body.cancel().catch(() => undefined);
      }
      cursor = `${object.created_at}|${object.id}`;
    }
    await closeRun(bindings.DB, runId, now, { status: "COMPLETED", copiedCount: copied, cursor });
    return { kind: "originals_incremental" as const, copied, remaining: batch.results.length === INCREMENTAL_BATCH };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeRun(bindings.DB, runId, now, { status: "FAILED", cursor: previousCursor, error: message.slice(0, 1000) });
    throw error;
  }
}

/** Bütün uygulama tablolarının kanonik JSON dökümü (ADR-017: günlük bağımsız dışa aktarım). */
async function runMetadataExport(bindings: BackupDependencies, now: Date) {
  const runId = await openRun(bindings.DB, "metadata_export", now);
  try {
    const tables: Record<string, unknown[]> = {};
    for (const table of Object.keys(SCHEMA_MANIFEST).sort()) {
      const rows = await bindings.DB.prepare(`SELECT * FROM ${table}`).all();
      tables[table] = rows.results;
    }
    const body = JSON.stringify({
      exportVersion: BACKUP_EXPORT_VERSION,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      cutoff: now.toISOString(),
      tables,
    });
    const digest = await sha256Hex(body);
    const objectKey = stampKey("metadata", now);
    const writer = storageVaultWriter(bindings.BACKUP_FILES!, storageReader(bindings.ARCHIVE_FILES));
    await writer.putIfAbsent(objectKey, body, {
      contentType: "application/json",
      contentSha256Hex: digest.hex,
      customMetadata: { exportVersion: BACKUP_EXPORT_VERSION, schemaVersion: String(ARCHIVE_SCHEMA_VERSION) },
    });
    await closeRun(bindings.DB, runId, now, {
      status: "COMPLETED", objectKey, byteSize: digest.byteSize, sha256: digest.hex,
    });
    return { kind: "metadata_export" as const, objectKey, byteSize: digest.byteSize };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeRun(bindings.DB, runId, now, { status: "FAILED", error: message.slice(0, 1000) });
    throw error;
  }
}

/** Nesne defterinin kesim zamanlı manifesti (ADR-017: günde en az bir). */
async function runDailyManifest(bindings: BackupDependencies, now: Date) {
  const runId = await openRun(bindings.DB, "manifest_daily", now);
  try {
    const objects = await bindings.DB.prepare(`SELECT id, document_id, object_class, media_type,
        byte_size, sha256, created_at
      FROM binary_objects ORDER BY created_at, id`)
      .all<{ id: string; document_id: string; object_class: string; media_type: string;
        byte_size: number; sha256: string; created_at: string }>();
    const totals = objects.results.reduce((sum, object) => ({
      objects: sum.objects + 1, bytes: sum.bytes + Number(object.byte_size ?? 0),
    }), { objects: 0, bytes: 0 });
    // Sağlayıcı anahtarı manifeste girmez (ADR-017): kimlik + SHA-256 yeter.
    const body = JSON.stringify({
      manifestVersion: BACKUP_EXPORT_VERSION,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      cutoff: now.toISOString(),
      totals,
      objects: objects.results.map((object) => ({
        id: object.id,
        documentId: object.document_id,
        objectClass: object.object_class,
        mediaType: object.media_type,
        byteSize: object.byte_size,
        sha256: object.sha256,
        createdAt: object.created_at,
      })),
    });
    const digest = await sha256Hex(body);
    const objectKey = stampKey("manifests", now);
    const writer = storageVaultWriter(bindings.BACKUP_FILES!, storageReader(bindings.ARCHIVE_FILES));
    await writer.putIfAbsent(objectKey, body, {
      contentType: "application/json",
      contentSha256Hex: digest.hex,
      customMetadata: { manifestVersion: BACKUP_EXPORT_VERSION, objectCount: String(totals.objects) },
    });
    await closeRun(bindings.DB, runId, now, {
      status: "COMPLETED", objectKey, byteSize: digest.byteSize, sha256: digest.hex,
      copiedCount: totals.objects,
    });
    return { kind: "manifest_daily" as const, objectKey, objectCount: totals.objects };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeRun(bindings.DB, runId, now, { status: "FAILED", error: message.slice(0, 1000) });
    throw error;
  }
}

/**
 * Aylık tutarlılık kontrolü (ADR-017 tatbikatının otomatik ayağı): yedeğin
 * VAR OLDUĞUNU değil, OKUNABİLİR ve DOĞRU olduğunu ölçer.
 *
 * - Son üst veri dökümü ve son manifest yedekten geri okunur, SHA-256 yeniden
 *   hesaplanıp defterdeki değerle karşılaştırılır (bit çürümesi/eksik yazım).
 * - Artımlı kopyanın imleç gerisindeki son N aslı yedekte aranır ve boyutu
 *   doğrulanır (kopya atlaması).
 *
 * Uyuşmazlık koşuyu FAILED bırakır ve alarm tetikler; yedeğin bozuk olduğunu
 * geri yükleme gününde öğrenmek en pahalı öğrenme biçimidir.
 */
async function runConsistencyCheck(bindings: BackupDependencies, now: Date) {
  const runId = await openRun(bindings.DB, "consistency_check", now);
  try {
    const reader = storageReader(bindings.BACKUP_FILES!);
    const problems: string[] = [];
    let checked = 0;

    // 1) Defterdeki son döküm ve manifest, yedekten geri okunup özetlenir.
    for (const kind of ["metadata_export", "manifest_daily"] as const) {
      const last = await bindings.DB.prepare(`SELECT object_key, sha256, byte_size FROM backup_runs
        WHERE kind = ? AND status = 'COMPLETED' AND object_key IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1`).bind(kind)
        .first<{ object_key: string; sha256: string; byte_size: number }>();
      if (!last) continue;
      checked += 1;
      const object = await reader.get(last.object_key);
      if (!object || object.range !== null) {
        problems.push(`${kind}: ${last.object_key} yedekten okunamadı`);
        continue;
      }
      const bytes = await new Response(object.body).arrayBuffer();
      const digest = digestToHex(await crypto.subtle.digest("SHA-256", bytes));
      if (digest !== last.sha256 || bytes.byteLength !== last.byte_size) {
        problems.push(`${kind}: ${last.object_key} özeti defterle uyuşmuyor (beklenen ${last.sha256.slice(0, 12)}…, okunan ${digest.slice(0, 12)}…)`);
      }
    }

    // 2) İmleç gerisindeki son N asıl yedekte var mı ve boyutu doğru mu?
    const incremental = await lastCompleted(bindings.DB, "originals_incremental");
    const [cursorAt] = (incremental?.cursor ?? "").split("|");
    if (cursorAt) {
      const sample = await bindings.DB.prepare(`SELECT id, object_key, byte_size FROM binary_objects
        WHERE object_class = 'original' AND created_at <= ?
        ORDER BY created_at DESC, id DESC LIMIT ${CONSISTENCY_SAMPLE}`)
        .bind(cursorAt)
        .all<{ id: string; object_key: string; byte_size: number }>();
      for (const object of sample.results) {
        checked += 1;
        const stat = await reader.head(object.object_key);
        if (!stat) problems.push(`asıl kopya eksik: ${object.id}`);
        else if (stat.size !== object.byte_size) problems.push(`asıl kopya boyutu uyuşmuyor: ${object.id}`);
      }
    }

    if (problems.length) throw new Error(`Yedek tutarlılık kontrolü ${problems.length} uyuşmazlık buldu: ${problems.join("; ")}`);
    await closeRun(bindings.DB, runId, now, { status: "COMPLETED", copiedCount: checked });
    return { kind: "consistency_check" as const, checked };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeRun(bindings.DB, runId, now, { status: "FAILED", error: message.slice(0, 1000) });
    throw error;
  }
}

export type BackupSliceResult =
  | { skipped: true; reason: "unconfigured" | "idle" }
  | { skipped: false; kind: BackupKind; detail: Record<string, unknown> };

/**
 * Bakım turunun yedek dilimi: sırası gelen EN FAZLA BİR işi çalıştırır.
 * Artımlı kopya önceliklidir (RPO'su en sıkı olan odur); günlükler onu izler.
 * Arıza turu düşürmez: defterde FAILED satır + alarm bırakır, sonraki tur
 * yeniden dener.
 */
export async function runBackupSlice(
  bindings: BackupDependencies,
  options: { now?: Date } = {},
): Promise<BackupSliceResult> {
  if (!bindings.BACKUP_FILES) return { skipped: true, reason: "unconfigured" };
  const now = options.now ?? new Date();
  const [incremental, metadata, manifest, consistency] = await Promise.all([
    lastCompleted(bindings.DB, "originals_incremental"),
    lastCompleted(bindings.DB, "metadata_export"),
    lastCompleted(bindings.DB, "manifest_daily"),
    lastCompleted(bindings.DB, "consistency_check"),
  ]);
  try {
    if (due(incremental, INCREMENTAL_INTERVAL_MS, now)) {
      const result = await runIncremental(bindings, now, incremental?.cursor ?? null);
      logEvent("info", "backup.slice", { ...result });
      return { skipped: false, kind: result.kind, detail: result };
    }
    if (due(metadata, DAILY_INTERVAL_MS, now)) {
      const result = await runMetadataExport(bindings, now);
      logEvent("info", "backup.slice", { kind: result.kind, objectKey: result.objectKey, byteSize: result.byteSize });
      return { skipped: false, kind: result.kind, detail: result };
    }
    if (due(manifest, DAILY_INTERVAL_MS, now)) {
      const result = await runDailyManifest(bindings, now);
      logEvent("info", "backup.slice", { kind: result.kind, objectKey: result.objectKey, objectCount: result.objectCount });
      return { skipped: false, kind: result.kind, detail: result };
    }
    // Tutarlılık ancak doğrulanacak bir yedek varken anlamlıdır; ilk manifest
    // üretilmeden koşarsa "hiçbir şey kontrol etmedim" satırı COMPLETED görünürdü.
    if (manifest && due(consistency, CONSISTENCY_INTERVAL_MS, now)) {
      const result = await runConsistencyCheck(bindings, now);
      logEvent("info", "backup.slice", { kind: result.kind, checked: result.checked });
      return { skipped: false, kind: result.kind, detail: result };
    }
    return { skipped: true, reason: "idle" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("error", "backup.failed", { error: message });
    await dispatchAlert(bindings, {
      severity: "critical",
      event: "backup.failed",
      title: "Yedek koşusu arızalandı; defterde FAILED kaydı var, sonraki bakım turu yeniden deneyecek.",
      detail: { error: message },
    });
    return { skipped: true, reason: "idle" };
  }
}

/** Genel bakış için yedek durumu: son başarılı koşular + son 24 saat arızaları. */
export async function readBackupSummary(bindings: Pick<ArchiveBindings, "DB" | "BACKUP_FILES">) {
  if (!bindings.BACKUP_FILES) return { configured: false as const };
  const [incremental, metadata, manifest, consistency, failures] = await Promise.all([
    lastCompleted(bindings.DB, "originals_incremental"),
    lastCompleted(bindings.DB, "metadata_export"),
    lastCompleted(bindings.DB, "manifest_daily"),
    lastCompleted(bindings.DB, "consistency_check"),
    // İki taraf da datetime() ile normalleştirilir; kolon ISO ('T'li) yazılır
    // ve ham TEXT karşılaştırmasında 'T' > ' ' her satırı "son 24 saat" yapardı.
    bindings.DB.prepare(`SELECT COUNT(*) AS n FROM backup_runs
      WHERE status = 'FAILED' AND datetime(started_at) >= datetime('now', '-1 day')`).first<{ n: number }>(),
  ]);
  return {
    configured: true as const,
    lastIncrementalAt: incremental?.completed_at ?? null,
    lastMetadataExportAt: metadata?.completed_at ?? null,
    lastManifestAt: manifest?.completed_at ?? null,
    lastConsistencyAt: consistency?.completed_at ?? null,
    failures24h: Number(failures?.n ?? 0),
  };
}
