import { jsonError } from "./http.ts";
import { correlationId, logEvent } from "./observability.ts";

/**
 * Hata sınırı.
 *
 * İç hata metinleri (SQL ifadeleri, tablo adları, depolama yolları, sağlayıcı
 * mesajları) istemciye aynen dönmemelidir: hem sistem yapısını açığa çıkarır hem
 * de kullanıcıya anlamsızdır. İstemciye genel bir mesaj ve korelasyon kimliği
 * gider; ayrıntı sunucu günlüğüne yazılır ve aynı kimlikle bulunabilir.
 *
 * Kullanıcıya gösterilmesi **istenen** doğrulama mesajları `PublicError` ile
 * fırlatılır; bunlar olduğu gibi döner.
 */
export class PublicError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

export function isPublicError(error: unknown): error is PublicError {
  return error instanceof PublicError;
}

/**
 * Beklenmeyen hatayı günlüğe yazar ve istemciye genel yanıt döner.
 *
 * `context` günlükte hangi işlemin başarısız olduğunu gösterir; istemciye
 * gitmez.
 */
export function failure(error: unknown, context: string, fallback = "İşlem tamamlanamadı.", request?: Request) {
  if (isPublicError(error)) return jsonError(error.message, error.status);
  const reference = correlationId(request);
  // Ayrıntı yalnız sunucu tarafında kalır.
  logEvent("error", "request.failure", {
    correlationId: reference,
    context,
    error: error instanceof Error ? error.message : String(error),
  });
  return jsonError(`${fallback} Destek için olay kimliği: ${reference}`, 500);
}
