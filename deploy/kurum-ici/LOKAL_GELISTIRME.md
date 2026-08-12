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

`database` ve `objectStorage` yeşil, `schema` v22 olmalı. `ocr` ve
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

Beklenen: `{"applied":true,"fromVersion":0,"toVersion":22}`. Ardından
`http://localhost:3000/archive` çalışma alanını açar; yerel pilot kimliği
otomatik yönetici olarak tanınır.

**Örnek belge verisi.** Lokalde OCR ve içerik tarama servisleri çalışmadığı
için kabul hattı belgeleri karantinada bırakır; liste, arama, doğrulama ve
belge inceleme ekranları boş kalır. Tohum betiği bu boşluğu doldurur:

```bash
node scripts/seed-dev-data.mjs
```

Yedi belge yazar: arşivlenmiş (doğrulanmış alanlar ve ilişkilerle), doğrulama
bekleyen, OCR'ı süren, kuyruktaki ve OCR'ı başarısız olan kayıtlar; OCR
sayfaları, alan değerleri, ada/parsel varlık ilişkileri ve denetim olaylarıyla
birlikte. Betik idempotenttir ve yalnız `.wrangler/` ya da `data/` altındaki
geliştirme veritabanına yazar. Tohum kayıtları SİLİNMEZ — denetim olayları
değişmezdir; temiz başlangıç için aşağıdaki sıfırlama kullanılır.

**Yerel durumu sıfırlama.** `.wrangler/state/v3/d1` ve `.../r2` dizinleri
yerel D1/R2 emülasyon verisidir. Şema hatası alıyorsanız (ör. eski bir
sürümde kalmış veritabanı `duplicate column` üretir) bu iki dizini silip
sunucuyu yeniden başlatın ve göçü tekrar çalıştırın.

> Not: `vite.config.ts` içindeki `LOCAL_COMPATIBILITY_DATE`, kurulu workerd
> binary'sinin desteklediği en yeni tarihtir ve YALNIZ yerel emülasyon
> içindir; dağıtım tarihi `wrangler.jsonc`'ta kalır.

## Tarama/terfi de dahil tam hat isteniyorsa

QUARANTINED sonrası ACCEPTED'a giden zincir üç Python servisini ister
(content-scan, ocr, document-render) ve gerçek nesne deposunu. Bunun için
`docker compose` yığını gerekir: Docker'lı bir makinede `AYAGA_KALDIRMA.md`
izlenir. Yalnız Node/depolama/DB katmanını geliştirirken bu belge yeterlidir.

## Temizlik

`data/` dizini `.gitignore`dadır; silmek durumu sıfırlar.
