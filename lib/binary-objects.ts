/**
 * Yetkili nesne kayıtlarını çözer. Fiziksel anahtar veya sağlayıcı listesi
 * görüntüleme kararı vermez; karar yalnız `binary_objects` + tamamlanmış üretim
 * kanıtından çıkar.
 */

export type StoredObject = {
  /** Yetkili `binary_objects` kimliği; erişim bileti bu kimliğe bağlanır (F1.9). */
  id: string;
  object_key: string;
  bucket_or_namespace: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  page_start?: number | null;
  page_end?: number | null;
  derivative_generation_id?: string | null;
};

export type ResolvedObject = {
  object: StoredObject;
  objectClass: "original" | "access";
  segment?: { index: number; total: number };
};

/** PDF türevi yok, tamamlanmamış veya kanıtı tutarsız: asıl SUNULMAZ. */
export type PendingDerivative = { pendingDerivative: true };

export function isPendingDerivative(value: ResolvedObject | PendingDerivative): value is PendingDerivative {
  return "pendingDerivative" in value;
}

export async function resolveOriginalObject(db: D1Database, documentId: string): Promise<StoredObject | null> {
  return await db.prepare(`SELECT id, object_key, bucket_or_namespace, media_type, byte_size, sha256
    FROM binary_objects
    WHERE document_id = ? AND object_class = 'original' AND retention_status <> 'DISPOSED'
    LIMIT 1`).bind(documentId).first<StoredObject>();
}

type CompletedGeneration = {
  id: string;
  page_count: number;
  segment_count: number;
};

function isCompleteGeneration(segments: StoredObject[], generation: CompletedGeneration) {
  if (segments.length !== Number(generation.segment_count) || !segments.length) return false;
  let expectedStart = 1;
  for (const segment of segments) {
    if (segment.derivative_generation_id !== generation.id
      || segment.media_type !== "application/pdf"
      || segment.bucket_or_namespace !== "DERIVATIVE_FILES"
      || Number(segment.page_start) !== expectedStart
      || !Number.isSafeInteger(Number(segment.page_end))
      || Number(segment.page_end) < expectedStart) return false;
    expectedStart = Number(segment.page_end) + 1;
  }
  return expectedStart === Number(generation.page_count) + 1;
}

/**
 * PDF görüntüleme yalnız tamamlanmış ve eksiksiz üretim kuşağından yapılır.
 * Aynı renderer/profil yeniden çalışsa bile kuşak kimliği segment karışmasını
 * engeller. PDF dışı türlerde de yalnız erişim türevi döner; türev yoksa
 * asıl nesneye düşmeden üretimin beklenmesi bildirilir.
 */
export async function resolveViewableObject(
  db: D1Database,
  documentId: string,
  segment = 1,
): Promise<ResolvedObject | PendingDerivative | null> {
  const original = await resolveOriginalObject(db, documentId);
  if (!original) return null;

  if (original.media_type === "application/pdf") {
    const generation = await db.prepare(`SELECT id, page_count, segment_count
      FROM derivative_jobs
      WHERE document_id = ? AND status = 'COMPLETED'
        AND page_count IS NOT NULL AND segment_count IS NOT NULL
      ORDER BY completed_at DESC, created_at DESC LIMIT 1`)
      .bind(documentId).first<CompletedGeneration>();
    if (!generation) return { pendingDerivative: true };
    const rows = await db.prepare(`SELECT id, object_key, bucket_or_namespace, media_type, byte_size,
        sha256, page_start, page_end, derivative_generation_id
      FROM binary_objects
      WHERE document_id = ? AND object_class = 'access'
        AND retention_status <> 'DISPOSED' AND derivative_generation_id = ?
      ORDER BY page_start`)
      .bind(documentId, generation.id).all<StoredObject>();
    if (!isCompleteGeneration(rows.results, generation)) return { pendingDerivative: true };
    if (!Number.isSafeInteger(segment) || segment < 1 || segment > rows.results.length) return null;
    return {
      object: rows.results[segment - 1],
      objectClass: "access",
      segment: { index: segment, total: rows.results.length },
    };
  }

  const access = await db.prepare(`SELECT id, object_key, bucket_or_namespace, media_type, byte_size,
      sha256, page_start, page_end, derivative_generation_id
    FROM binary_objects
    WHERE document_id = ? AND object_class = 'access' AND retention_status <> 'DISPOSED'
    ORDER BY created_at DESC LIMIT 1`).bind(documentId).first<StoredObject>();
  return access ? { object: access, objectClass: "access" } : { pendingDerivative: true };
}
