/**
 * Uygulama kabuğu service worker'ı.
 *
 * Önceki sürüm her GET yanıtını Cache Storage'a kopyalıyordu; bu, belge
 * baytlarının (`/api/documents/{id}/file`) ortak kullanılan bir belediye
 * bilgisayarının diskinde oturum kapandıktan sonra da kalması anlamına
 * geliyordu. Yanıt `cache-control: private` gönderse bile custom bir service
 * worker bunu dikkate almaz.
 *
 * Bu sürüm yalnız statik kabuk varlıklarını önbelleğe alır. API yanıtları, belge
 * dosyaları ve üst veri asla saklanmaz. Önbellek adı v2'ye yükseltildiği için
 * etkinleşme sırasında eski önbellekler — içinde kalmış belge yanıtlarıyla
 * birlikte — silinir.
 */
const CACHE = "sivas-arsiv-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg"];

/** Yalnız bu yollar önbelleğe alınabilir. Diğer her şey doğrudan ağdan geçer. */
function isCacheableShellRequest(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (SHELL.includes(url.pathname)) return true;
  // Derlenmiş statik varlıklar ve ikonlar.
  return /^\/(_vinext|assets)\//.test(url.pathname)
    || /\.(css|js|woff2?|svg|png|ico|webmanifest)$/.test(url.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (!isCacheableShellRequest(request, url)) {
    // API ve belge dosyası istekleri hiç saklanmaz. Gezinmede çevrimdışı kabuk
    // geri dönüşü verilir; başka her istek doğrudan ağa gider.
    if (request.mode === "navigate") {
      event.respondWith(fetch(request).catch(() => caches.match("/")));
    }
    return;
  }

  event.respondWith(fetch(request).then((response) => {
    // Yalnız başarılı ve aynı kökenli yanıtlar saklanır.
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || caches.match("/"))));
});
