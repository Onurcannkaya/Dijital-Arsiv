# Lokal Geliştirme (Docker'sız)

Uygulama API'sini tek makinede, MinIO/Docker olmadan çalıştırma yolu. Depolama
yerel diske düşer (`ARCHIVE_STORAGE_DRIVER=local`), veritabanı gömülü SQLite'tır.
Sunucu bağımlılığı yoktur; `node server/main.ts` doğrudan koşar.

> Bu sürücü YALNIZ geliştirme/deneme içindir. Kabul koşusu ve üretim daima
> gerçek S3/MinIO adaptörünü kullanır (`ARCHIVE_STORAGE_DRIVER` verilmez);
> davranış eşliği sözleşme testleriyle güvence altındadır.

## Çalıştırma

```bash
# Depo kökünden. Yönetici e-postası ilk istekte 'admin' rolüyle bootstrap olur.
ARCHIVE_STORAGE_DRIVER=local \
ARCHIVE_LOCAL_STORAGE_DIR=data/storage \
ARCHIVE_DB_PATH=data/arsiv.db \
ARCHIVE_ADMIN_EMAILS=you@sivas.bel.tr \
APP_ENV=staging \
ARCHIVE_HTTP_PORT=8788 \
node server/main.ts
```

Sağlık:

```bash
curl -s http://127.0.0.1:8788/api/health
```

`database` ve `objectStorage` yeşil, `schema` güncel sürümde olmalı
(yetkili kaynak `lib/archive-schema.ts` içindeki `ARCHIVE_SCHEMA_VERSION`).
`ocr` ve
`contentScan` `false` döner — bunlar ayrı Python servisleridir ve lokalde
çalışmaz; bu yüzden genel durum `degraded`'dir. Bu beklenen durumdur:
yükleme → tamamlama → QUARANTINED zinciri bu servisler olmadan tam çalışır;
yalnız QUARANTINED sonrası tarama/terfi adımı için servisler gerekir.

## Uçtan uca yükleme provası

```bash
node - <<'NODE'
const BASE = "http://127.0.0.1:8788";
const H = { "oai-authenticated-user-email": "you@sivas.bel.tr" };
const { createHash } = await import("node:crypto");
const f = await import("./scripts/acceptance-executors/fixtures.mjs");
const payload = f.buildPdfFixture({ text: "lokal-prova" });
const sha = createHash("sha256").update(payload).digest("hex");
const j = async (m, p, body, extra) => {
  const r = await fetch(BASE + p, { method: m, headers: { ...H, ...(body ? { "content-type": "application/json" } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const created = await j("POST", "/api/uploads", { unit: "Yazı İşleri Müdürlüğü", byteSize: payload.byteLength, mediaType: "application/pdf", originalName: "lokal-prova.pdf" }, { "idempotency-key": "lokal-" + Date.now() });
const id = created.body.session.id;
await fetch(`${BASE}/api/uploads/${id}/parts`, { method: "PUT", headers: { ...H, "x-part-number": "1", "x-content-sha256": sha, "content-type": "application/octet-stream" }, body: payload });
const done = await j("POST", `/api/uploads/${id}/complete`, {});
console.log("durum:", done.body.session.status, "| SHA eşleşti:", done.body.session.sha256 === sha);
NODE
```

Beklenen çıktı: `durum: QUARANTINED | SHA eşleşti: true`. Fiziksel nesne
`data/storage/arsiv-karantina/objects/` altında görünür.

## Arayüz (UI) geliştirme

Arayüz Workers çalışma zamanında koşar; yerelde Miniflare emülasyonuyla
`npm run dev` yeterlidir (Docker gerekmez):

```bash
npm run dev     # http://localhost:3000
```

İlk açılışta veritabanı boştur ve API'ler 500 döner; şema göçünü bir kez
çalıştırın (jeton `.dev.vars` içindedir):

```bash
curl -X POST -H "authorization: Bearer $(grep '^ARCHIVE_MIGRATION_TOKEN=' .dev.vars | cut -d= -f2-)" \
  http://localhost:3000/api/admin/migrate
```

Beklenen: `{"applied":true,"fromVersion":0,"toVersion":<ARCHIVE_SCHEMA_VERSION>}`
(sayı `lib/archive-schema.ts` ile birlikte ilerler; sabit yazılmaz). Ardından
`http://localhost:3000/archive` çalışma alanını açar; yerel pilot kimliği
otomatik yönetici olarak tanınır.

**Örnek belge verisi.** Lokalde OCR ve içerik tarama servisleri çalışmadığı
için kabul hattı belgeleri karantinada bırakır; liste, arama, doğrulama ve
belge inceleme ekranları boş kalır. Tohum betiği bu boşluğu doldurur:

```bash
node scripts/seed-dev-data.mjs
```

Sekiz belge yazar: arşivlenmiş (doğrulanmış alanlar ve ilişkilerle), doğrulama
bekleyen, OCR'ı süren, kuyruktaki ve OCR'ı başarısız olan kayıtlar; OCR
sayfaları, alan değerleri, ada/parsel varlık ilişkileri ve denetim olaylarıyla
birlikte. Betik idempotenttir ve yalnız `.wrangler/` ya da `data/` altındaki
geliştirme veritabanına yazar. Tohum kayıtları SİLİNMEZ — denetim olayları
değişmezdir; temiz başlangıç için aşağıdaki sıfırlama kullanılır.

> **Tohum belgelerinin fiziksel dosyası yoktur.** Betik yalnız veritabanı
> satırı yazar; kasaya (R2/MinIO) nesne koymaz. Bu yüzden tohum bir belgesi
> açıldığında önizleme "Güvenli görüntüleme kopyası henüz hazırlanıyor"
> (türev nesne yok), **Aslını indir** ise "Belgenin aslı kasada bulunamadı"
> döner. Bu bir kusur değildir: erişim bileti, kapsam denetimi ve denetim
> kaydı doğru çalışmış, dosya sunumu kasada nesne olmadığı için durmuştur.
> Bayt akışının uçtan uca denenmesi terfi etmiş gerçek bir belge ister; o da
> tarama servisini, yani `docker compose` yığınını gerektirir
> (`AYAGA_KALDIRMA.md`).

**Yerel durumu sıfırlama.** `.wrangler/state/v3/d1` ve `.../r2` dizinleri
yerel D1/R2 emülasyon verisidir. Şema hatası alıyorsanız (ör. eski bir
sürümde kalmış veritabanı `duplicate column` üretir) bu iki dizini silip
sunucuyu yeniden başlatın ve göçü tekrar çalıştırın.

> Not: `vite.config.ts` içindeki `LOCAL_COMPATIBILITY_DATE`, kurulu workerd
> binary'sinin desteklediği en yeni tarihtir ve YALNIZ yerel emülasyon
> içindir; dağıtım tarihi `wrangler.jsonc`'ta kalır.

## Belge yükleme

Arayüzden belge yüklemek yerelde çalışır: oturum açılır, parçalar SHA-256 ile
doğrulanır ve nesne karantinaya alınır. Yükleme dört ayrı R2 bağı kullanır
(geçici, karantina, asıl kasa, türev) ve bunlar `vite.config.ts` içinde yerel
emülasyon için tanımlıdır.

Belge yükleme sonrası listede GÖRÜNMEZ; bu doğru davranıştır. `archive_documents`
kaydı ancak tarama ve terfi tamamlandığında oluşur (F1.5). Lokalde tarama
servisi olmadığından oturum `QUARANTINED` durumunda bekler.

## Tarama/terfi de dahil tam hat — Docker'sız

Yerel zincir (yükleme → tarama → terfi → **gerçek PaddleOCR** → önizleme)
Docker olmadan çalışır. İki yardımcı süreç ve `.dev.vars` içinde beş anahtar
gerekir:

```bash
# .dev.vars — jetonları kendiniz üretin (secrets.token_urlsafe)
OCR_SERVICE_URL=http://127.0.0.1:8090
OCR_SERVICE_TOKEN=<jeton>
CONTENT_SCAN_SERVICE_URL=http://127.0.0.1:8091
CONTENT_SCAN_SERVICE_TOKEN=<jeton>
ARCHIVE_INTERNAL_OBJECT_FETCH=enabled
```

`ARCHIVE_INTERNAL_OBJECT_FETCH` YALNIZ yerel geliştirme içindir: Miniflare
R2'nin S3 ucu olmadığından servisler nesneleri `/api/internal/objects`
ucundan indirir (kapsam başına jeton, önek kilidi, yol geçişi reddi).
Üretimde ve kabul koşusunda tanımlanmaz; servisler MinIO'ya salt-okunur
kimlikle doğrudan bağlanır (ADR-014).

```bash
# 1) Gerçek OCR servisi (fastapi+uvicorn+paddleocr kurulu olmalı).
#    OCR_PRELOAD_MODEL=true önemlidir: model yüklenir VE küçük bir ısınma
#    çıkarımı koşar. İlk çıkarım oneDNN derlemesini öder (ölçüm: aynı görüntü
#    soğuk süreçte 155 sn, ısınmışta 45 sn) ve ısınmadan gelen ilk gerçek
#    belge, uygulamanın 120 sn'lik iş tavanını aşıp bir deneme hakkı yakar.
cd services/ocr
OCR_SERVICE_TOKEN=<jeton> OCR_FETCH_URL=http://localhost:3000/api/internal/objects PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True OCR_PRELOAD_MODEL=true python -m uvicorn app.main:app --host 127.0.0.1 --port 8090

# 2) İçerik tarama taklidi (clamav/qpdf yerelde yok; sihirli bayt + SHA
#    denetimini GERÇEKTEN yapar, alındıya "gelistirme-stub" yazar)
CONTENT_SCAN_SERVICE_TOKEN=<jeton> INTERNAL_FETCH_URL=http://localhost:3000/api/internal/objects node scripts/dev-content-scan.mjs
```

Cron yerelde ateşlenmez; tarama+terfi turu elle ilerletilir (arayüzdeki
yönetici kimliğiyle):

```bash
curl -X POST http://localhost:3000/api/admin/scan   # tarama + terfi turu
```

Belge `queued` durumuna geçince inceleme ekranındaki **"OCR işlemini
çalıştır"** düğmesi gerçek PaddleOCR'ı koşturur (ilk çağrıda model yüklenir,
~1 dk). Alanlar, ilişki önerileri ve görüntüleme türevi üretilir; önizleme
gerçek taramayı gösterir.

> Not: `vite.config.ts` `.dev.vars` dosyasını yerel bağlara kendisi taşır —
> buradaki inline yapılandırma wrangler.jsonc'un yerine geçtiğinden eklenti
> dosyayı kendiliğinden okumaz. Yeni anahtar eklerseniz dev sunucusunu
> yeniden başlatın.

Gerçek üretim eşleniği (ClamAV, qpdf, MinIO, document-render) için
`docker compose` yığını gerekir: Docker'lı bir makinede `AYAGA_KALDIRMA.md`
izlenir.

## Temizlik

`data/` dizini `.gitignore`dadır; silmek durumu sıfırlar.
