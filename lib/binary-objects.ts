/**
 * Nesne kaydı sorguları.
 *
 * `archive-storage.ts` çalışma zamanı bağlamasını (`cloudflare:workers`) içe
 * aktarır; bu sorgular ondan ayrı tutulur ki davranışları testte gerçekten
 * çalıştırılabilsin.
 *
 * Yetkili liste `binary_objects` tablosudur
 * (S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §8).
 */

export type StoredObject = {
  object_key: string;
  media_type: string;
  byte_size: number;
  sha256: string;
};

export type ResolvedObject = { object: StoredObject; objectClass: "original" | "access" };

/**
 * Belgenin asıl nesnesini çözer.
 *
 * Yetkili kayıt yalnız `binary_objects` tablosundadır. Sürüm 8 göçü tarihsel
 * belgeleri geriye dönük doldurur; `archive_documents.storage_key` artık okuma
 * yolu değildir ve fiziksel sütun sonraki uyumlu sürümde kaldırılacaktır.
 */
export async function resolveOriginalObject(db: D1Database, documentId: string): Promise<StoredObject | null> {
  return await db.prepare(`SELECT object_key, media_type, byte_size, sha256 FROM binary_objects
    WHERE document_id = ? AND object_class = 'original' LIMIT 1`).bind(documentId).first<StoredObject>();
}

/**
 * Görüntüleme için sunulacak nesneyi çözer.
 *
 * Öncelik erişim türevindedir: `document.read` yetkisi değiştirilemez aslı
 * açmamalıdır (S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5). Türev henüz
 * üretilmemişse (örneğin PDF'lerde) asıl döner ve sunulan sınıf çağırana
 * bildirilir; denetim kaydına yazılır ve eksik türev sayısı raporlanır.
 */
export async function resolveViewableObject(db: D1Database, documentId: string): Promise<ResolvedObject | null> {
  const access = await db.prepare(`SELECT object_key, media_type, byte_size, sha256 FROM binary_objects
    WHERE document_id = ? AND object_class = 'access' ORDER BY created_at DESC LIMIT 1`)
    .bind(documentId).first<StoredObject>();
  if (access) return { object: access, objectClass: "access" };
  const original = await resolveOriginalObject(db, documentId);
  return original ? { object: original, objectClass: "original" } : null;
}
