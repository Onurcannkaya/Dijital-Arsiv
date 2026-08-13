/**
 * Çalışma zamanı bağlamı gerektirmeyen HTTP yardımcıları.
 *
 * `archive-storage.ts` çalışma zamanı önyüklemesini (`workers-runtime.ts`)
 * içe aktarır; yetkilendirme gibi saf mantığın test edilebilmesi için bu
 * yardımcılar ondan ayrı tutulur.
 */
/**
 * `code`, istemcinin metne bakmadan ayırt edebilmesi içindir: kabul hattında
 * her ret makine okunur bir kodla gelir ve tümleşik istemciler buna dayanır.
 * Metin değişebilir, kod sözleşmedir.
 */
export function jsonError(message: string, status = 400, code?: string) {
  return Response.json(code ? { error: message, code } : { error: message }, { status });
}
