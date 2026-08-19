"use client";

/**
 * Güvenli yükleme zinciri — masaüstü diyaloğu ile mobil tarama akışının
 * ORTAK yolu (design.md §4.4).
 *
 * Belge kabulünün tek kapısı yeniden başlatılabilir kabul API'sidir:
 * oturum aç → parçaları SHA-256 ile doğrulat → tamamla → KARANTİNA.
 * Zincir iki yüzeye kopyalanmaz; kopya, birinde yapılan güvenlik
 * düzeltmesinin öbüründe unutulması demektir. `tests/f13-upload-route`
 * her iki yüzeyin de bu modülü kullandığını kaynak düzeyinde denetler.
 */

export const PART_BYTES = 16 * 1024 * 1024;

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type SecureUploadInput = {
  file: File;
  documentType: string;
  unit: string;
  /** Aynı denemenin yeniden gönderimi ikinci oturum açmasın diye çağıran üretir. */
  idempotencyKey: string;
  onProgress?: (message: string) => void;
};

/**
 * Dosyayı kabul hattından geçirir; başarıda oturum kimliğini döner, hatada
 * insan okunur mesajla fırlatır. Belge kaydı burada DOĞMAZ: kayıt, tarama ve
 * terfi tamamlanınca oluşur (F1.5) — karantina aşamasında listeye sahte satır
 * eklenmez. Oturum kimliği, hızlı kabul sihirbazının tarama/terfi/OCR
 * ilerlemesini yoklayabilmesi içindir.
 */
export async function uploadSecurely({ file, documentType, unit, idempotencyKey, onProgress }: SecureUploadInput): Promise<{ sessionId: string }> {
  const progress = onProgress ?? (() => undefined);
  progress("Güvenli yükleme oturumu hazırlanıyor…");
  const opened = await fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      originalName: file.name,
      documentType,
      unit,
      byteSize: file.size,
      mediaType: file.type || "application/octet-stream",
    }),
  });
  const openedPayload = await opened.json() as {
    session?: { id: string; missingParts: number[]; expectedPartCount: number }; error?: string };
  if (!opened.ok || !openedPayload.session) throw new Error(openedPayload.error || "Yükleme oturumu açılamadı.");
  const session = openedPayload.session;

  let uploaded = session.expectedPartCount - session.missingParts.length;
  for (let offset = 0; offset < session.missingParts.length; offset += 4) {
    const group = session.missingParts.slice(offset, offset + 4);
    await Promise.all(group.map(async (partNumber) => {
      const singlePart = session.expectedPartCount === 1;
      const start = singlePart ? 0 : (partNumber - 1) * PART_BYTES;
      const end = singlePart ? file.size : Math.min(start + PART_BYTES, file.size);
      const part = file.slice(start, end);
      const checksum = await sha256Hex(part);
      const response = await fetch(`/api/uploads/${session.id}/parts`, {
        method: "PUT",
        headers: { "x-part-number": String(partNumber), "x-content-sha256": checksum },
        body: part,
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || `${partNumber}. parça yüklenemedi.`);
      uploaded += 1;
      progress(`${uploaded}/${session.expectedPartCount} parça doğrulandı…`);
    }));
  }

  progress("Parçalar tamamlandı; nesne karantina alanına aktarılıyor…");
  const completed = await fetch(`/api/uploads/${session.id}/complete`, { method: "POST" });
  const completedPayload = await completed.json() as { session?: { status: string }; error?: string };
  if (!completed.ok || !completedPayload.session) throw new Error(completedPayload.error || "Yükleme tamamlanamadı.");
  return { sessionId: session.id };
}
