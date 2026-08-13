import { getArchiveBindings, getArchiveObjectStorage, getIngestStorages } from "../../../../lib/archive-storage";

export const dynamic = "force-dynamic";

/**
 * YALNIZ YEREL GELİŞTİRME — servisler için nesne okuma ucu.
 *
 * Üretimde ve kabul koşusunda tarama/OCR servisleri nesneleri MinIO'dan
 * salt-okunur servis kimliğiyle doğrudan indirir (ADR-014); belge baytları
 * uygulamadan geçmez. Yerel geliştirmede ise depo Miniflare R2 emülasyonudur
 * ve S3 ucu yoktur — F1.3 nesne-referanslı çağrıya geçtiğinden beri yerel
 * zincir bu yüzden kopuktu: servis aslı hiçbir yerden alamıyordu.
 *
 * Bu uç o boşluğu kapatır ve üç kilitle kapalı tutulur:
 *
 * 1. `ARCHIVE_INTERNAL_OBJECT_FETCH=enabled` değilse 404 — bilinmeyen rotadan
 *    ayırt edilemez. Bayrak yalnız `.dev.vars` içinde tanımlanır; hiçbir
 *    dağıtım yapılandırmasına girmez.
 * 2. Kapsam başına ayrı servis jetonu: karantina nesnesini yalnız tarama
 *    servisi, asıl nesneyi yalnız OCR servisi okuyabilir. ADR-014'ün rol
 *    ayrımı burada da korunur; tek jeton her şeyi açmaz.
 * 3. Anahtar öneki kapsama kilitlidir ve yol geçişi reddedilir; uç, keyfî
 *    anahtar okuyan bir vekile dönüşemez.
 */

const SCOPES = {
  quarantine: { prefix: "quarantine/", tokenKey: "CONTENT_SCAN_SERVICE_TOKEN" },
  original: { prefix: "originals/", tokenKey: "OCR_SERVICE_TOKEN" },
} as const;

export async function GET(request: Request) {
  const bindings = getArchiveBindings();
  const notFound = () => Response.json({ error: "Uç bulunamadı." }, { status: 404 });
  if (bindings.ARCHIVE_INTERNAL_OBJECT_FETCH !== "enabled") return notFound();

  const url = new URL(request.url);
  const scope = SCOPES[url.searchParams.get("scope") as keyof typeof SCOPES];
  const key = url.searchParams.get("key") ?? "";
  if (!scope) return notFound();

  const expected = bindings[scope.tokenKey];
  const presented = request.headers.get("authorization") ?? "";
  // Jeton yapılandırılmamışsa uç o kapsam için kapalıdır (fail-closed).
  if (!expected || presented !== `Bearer ${expected}`) {
    return Response.json({ error: "Servis kimliği doğrulanamadı." }, { status: 403 });
  }
  if (!key.startsWith(scope.prefix) || key.split("/").includes("..")) {
    return Response.json({ error: "Geçersiz nesne anahtarı." }, { status: 400 });
  }

  const storage = scope.prefix === "quarantine/"
    ? getIngestStorages(bindings).quarantine
    : getArchiveObjectStorage(bindings);
  const object = await storage.get(key);
  if (!object) return Response.json({ error: "Nesne bulunamadı." }, { status: 404 });

  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "no-store",
    },
  });
}
