/**
 * Çalışma zamanı bağlamı gerektirmeyen HTTP yardımcıları.
 *
 * `archive-storage.ts` `cloudflare:workers` modülünü içe aktarır; yetkilendirme
 * gibi saf mantığın test edilebilmesi için bu yardımcılar ondan ayrı tutulur.
 */
export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}
