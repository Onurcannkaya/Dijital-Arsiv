/**
 * F1.1 — Akışlı içerik özeti sözleşmesi.
 *
 * `crypto.subtle.digest()` artımlı değildir ve tüm girdiyi ister; büyük dosya
 * kabulünde kullanılamaz. Akışlı SHA-256 bir depolama yeteneği değil çalışma
 * zamanı yeteneğidir; bu yüzden depolama adaptörüne değil bu sözleşmenin
 * arkasına konur (YOL_HARITASI_FAZLAR.md §F1.1, ADR-014).
 *
 * İçerik SHA-256 kararı her durumda bu sözleşmeyle verilen sunucu hesabına
 * dayanır. Sağlayıcı ETag'i veya multipart bileşik checksum'ı içerik kanıtı
 * sayılmaz.
 */

export type StreamDigest = {
  sha256Hex: string;
  byteSize: number;
};

export interface StreamingHasher {
  /** Akımı tamamen tüketir; içerik SHA-256 (hex, küçük harf) ve boyut döndürür. */
  sha256(stream: ReadableStream<Uint8Array>): Promise<StreamDigest>;
}

export function digestToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Cloudflare çalışma zamanının standart dışı DigestStream uzantısı. */
type DigestStreamConstructor = new (algorithm: string) => WritableStream<Uint8Array> & {
  digest: Promise<ArrayBuffer>;
};

/**
 * Cloudflare Workers uygulaması: `crypto.DigestStream` ile sabit bellekte
 * akışlı SHA-256. Node testleri aynı sözleşmeyi `node:crypto` tabanlı test
 * uygulamasıyla doğrular (`tests/object-storage-contract.test.ts`).
 */
export function createDigestStreamHasher(): StreamingHasher {
  const DigestStream = (globalThis.crypto as unknown as { DigestStream?: DigestStreamConstructor }).DigestStream;
  if (!DigestStream) {
    throw new Error("Bu çalışma zamanında crypto.DigestStream yok; çalışma zamanına uygun StreamingHasher sağlayın.");
  }
  return {
    async sha256(stream: ReadableStream<Uint8Array>): Promise<StreamDigest> {
      const digestStream = new DigestStream("SHA-256");
      let byteSize = 0;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          byteSize += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      await stream.pipeThrough(counter).pipeTo(digestStream);
      return { sha256Hex: digestToHex(await digestStream.digest), byteSize };
    },
  };
}
