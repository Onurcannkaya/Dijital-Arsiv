# Kurum İçi Port Kapsamı

Bu belge, dikey pilotun (Cloudflare Workers + D1 + R2) belediye altyapısına
taşınmasının kapsamını çıkarır. Dayanak: `ANA_SISTEM_TASARIM_BELGESI.md`
("Mevcut D1/R2 uygulaması dikey pilot niteliğindedir") ve
`S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md` üretim öncesi karar listesi
("Üretim S3 sağlayıcısı ve kurum içi/bulut yerleşimi").

Temel bulgu: **kod tabanının büyük kısmı sağlayıcıdan bağımsızdır.** Cloudflare
bağımlılığı üç dar noktada toplanır — çalışma zamanı, veritabanı bağlaması ve
nesne depolama bağlaması. Bunların her biri için ya mevcut bir soyutlama ya da
repoda kanıtlanmış bir taşıma deseni vardır.

## 1. Envanter — ne dokunmadan taşınır, ne adaptör ister, ne yeniden kurulur

### 1.1 Dokunmadan taşınanlar (portun DIŞINDA)

| Varlık | Neden taşınabilir |
|---|---|
| İş mantığı çekirdeği: `lib/ingest-*.ts`, `lib/content-scan.ts`, `lib/ingest-promotion.ts`, `lib/access-tickets.ts`, `lib/integrity.ts`, `lib/reconciliation.ts`, `lib/storage-manifest.ts`, `lib/audit.ts` … | Yalnız `D1Database` arayüzü ve `lib/object-storage.ts` soyutlamaları üzerinden çalışır; Web standardı API'ler (fetch/Request/Response/Web Streams/crypto.subtle) Node 22'de birebir mevcut |
| Python servisleri: `services/content-scan`, `services/ocr`, `services/document-render` | Zaten kurum içi hedefli FastAPI konteynerleri; S3 erişimi boto3 ile — MinIO'ya `*_S3_ENDPOINT_URL` değişikliğiyle bağlanır |
| Veri şeması ve göçler: `lib/archive-schema.ts`, `lib/ingest-schema.ts` (denetim değişmezlik tetikleyicileri dahil) | SQLite lehçesi; kurum içi SQLite yolunda birebir çalışır (bkz. §3) |
| Kabul altyapısı: `scripts/phase-one-acceptance-*`, `scripts/acceptance-executors/*` (19 test) | Tasarım gereği sağlayıcıdan bağımsız: HTTPS + S3 SigV4. Kurum içi staging'e karşı aynen yeniden koşulur; T-10 taşınabilirliği zaten kanıtlıyor |
| Tam test takımı + `tests/sqlite-d1.ts` şimi | Node üzerinde koşuyor; şim, D1 arayüzünün gerçek SQLite ile karşılanabildiğinin kanıtı |
| UI (Next.js/Vinext app router, `app/`) | Yalnız sırsız sunum/PWA katmanıdır; DB, S3, kuyruk ve saklama kararı taşımaz. Müdürlük kısıtı gereği kurumsal çekirdek sayılmaz |

### 1.2 Uygulanan kurum içi adaptörler

| Nokta | Mevcut durum | Kurum içi karşılık | Boyut |
|---|---|---|---|
| Nesne depolama | `lib/node-s3-object-storage.ts`: MinIO/S3 SigV4, koşullu ilk yazma, multipart, akışlı okuma ve sürüm kimliği | P3 tamam; gerçek hedef davranışı T-01/P8 ile kanıtlanır | M |
| Yapılandırma/bağlama dikişi | `lib/archive-bindings.ts` + `lib/node-runtime.ts`: `process.env` ve rol adaptörü fabrikası | P1 tamam | S |
| Zamanlanmış işler | `server/` zamanlayıcısı aynı `lib/scheduled-jobs.ts` fonksiyonlarını çağırır | P4 tamam; gerçek makine süre/yeniden başlatma kanıtı P7/P8 | S |
| Veritabanı sürücüsü | `lib/node-sqlite-d1.ts`: WAL, tam fsync ve işlemsel `batch` | P2 tamam; tek süreç sınırı korunur | S-M |

### 1.3 Yeniden kurulacaklar

| Nokta | Mevcut durum | Kurum içi karşılık | Boyut |
|---|---|---|---|
| Çalışma zamanı | Workers + vinext (`@cloudflare/vite-plugin`) | Node 22 konteyneri; `next build` standalone çıktı ya da vite node hedefi. API rotaları standart Request/Response kullandığından rota kodu değişmez; build boru hattı değişir | M |
| Kimlik katmanı | `oai-authenticated-user-email` güvenilen başlığı (ChatGPT Apps proxy'si, `app/chatgpt-auth.ts`) | Ters vekil + kurum SSO (ör. Keycloak ↔ Active Directory, OIDC). Vekil aynı başlıkları enjekte ederse `lib/authorization.ts` değişmeden çalışır; başlık sahteciliğine karşı vekil-dışı trafiğin kapatılması şart | M |
| Sır yönetimi | Cloudflare worker secrets | Kurum standardı: Vault / k8s secrets / ortam dosyası + erişim denetimi | S |
| TLS ve ağ | Cloudflare kenarı | Kurum içi ters vekil (nginx/Traefik) + kurum sertifikaları; servisler arası ağ segmentasyonu (ADR-014 rol ayrımı MinIO politikalarıyla) | S-M |
| Gözlemlenebilirlik | `lib/observability.ts` yapılandırılmış log → Workers log | Aynı JSON logları stdout'tan merkezi log sistemine (ELK/Loki); alarm eşikleri | S |
| CI/CD | GitHub Actions → wrangler deploy | Kurum içi ağa erişen self-hosted runner ya da GitLab CI; deploy hedefi konteyner kayıt defteri + orkestrasyon | M |
| Yedekleme | R2 + geri yükleme kovası | MinIO site replication / ikinci DC hedefi; ADR-017 tatbikatı (T-09) aynı yürütücüyle koşar | M |

## 2. Bileşen eşlemesi (hedef mimari, tasarım belgesi §8 ile uyumlu)

| Pilot (Cloudflare) | Kurum içi hedef |
|---|---|
| Workers çalışma zamanı | Node 22 konteyneri (k8s ya da docker-compose) |
| D1 (SQLite) | 1. dalga: sunucu üstü SQLite (WAL) — 2. dalga: PostgreSQL (bkz. §3) |
| R2 kovaları (ARCHIVE/DERIVATIVE/TEMPORARY/QUARANTINE) | MinIO kovaları; asıl kasada **Object Lock (COMPLIANCE)** — R2 pilotunda telafi kontrolü olan WORM burada gerçek anlamda sağlanır (ADR-016 iyileşmesi) |
| Cron triggers | systemd timer / k8s CronJob → `/api/jobs/process` |
| ChatGPT Apps kimlik başlıkları | Ters vekil + Keycloak/AD (OIDC), aynı başlık sözleşmesi |
| workers.dev TLS | Kurum ters vekili + kurum sertifikası |
| İkinci sağlayıcı (T-10) | Ayrı DC'de ikinci MinIO örneği ya da farklı S3 uyumlu hedef |

## 3. Veritabanı yolu: iki dalgalı öneri

**1. dalga — SQLite ile birebir port (düşük risk, hızlı kabul kanıtı):**
D1 zaten SQLite'tır; bütün SQL, şema, göçler ve değişmezlik tetikleyicileri
(5 adet) hiç değişmeden çalışır. `tests/sqlite-d1.ts` kullanılan D1 yüzeyinin
tamamını zaten karşılıyor; üretim sarmalayıcısı bunun sertleştirilmiş hâlidir.
Sınır: tek yazarlı süreç modeli — belge arşivi yazma hacmi düşük ve iş kuyruğu
zaten kira/lease disiplinli olduğundan belediye ölçeğinde yeterlidir; yine de
kapasite kabulü İş Etki Analizine bağlanmalıdır.

**2. dalga — PostgreSQL'e planlı geçiş (tasarım belgesi hedefi):**
Gerektirdikleri: SQL lehçe dönüşümü (24 dosyada `INSERT OR IGNORE`,
`ON CONFLICT`, `CURRENT_TIMESTAMP`, `group_concat` vb.), tetikleyicilerin
PL/pgSQL karşılıkları, `LIKE` tabanlı aramanın `tsvector`/OpenSearch'e taşınması
ve göç araçları. Bu dalga portun ön koşulu DEĞİLDİR; 1. dalga üretim kabulünü
bloklamadan ayrı planlanır.

## 4. Kabul kanıtı stratejisi

Port "bitti" sayılmaz; **aynı 19 test kurum içi staging'e karşı yeniden koşulup
teknik kapı yeniden açılana kadar**. Değişen yalnız yetenek girdileridir
(`KABUL_ORTAM_KURULUMU.md` fazları MinIO uçlarına ve kurum kimliklerine
işaret eder):

- `ACCEPTANCE_S3_ENDPOINT` → kurum MinIO'su; `ACCEPTANCE_LOCK_PROFILE` →
  `s3-object-lock` (gerçek WORM profili),
- IAM rol kimlikleri → MinIO politika kullanıcıları (T-06/K-4 ayrımı fiilen doğrular),
- ikinci sağlayıcı → ikinci MinIO örneği (T-10),
- geri yükleme kovası → ikinci hata alanındaki MinIO (T-09, RPO/RTO ölçümü gerçek değerlerle).

## 5. Aşamalar ve kaba efor

| Aşama | İçerik | Boyut | Bağımlılık |
|---|---|---|---|
| P1 | Config dikişi: `getArchiveBindings` → `process.env` fabrikası | S | — |
| P2 | SQLite D1 sarmalayıcısı (üretim sınıfı) + kalıcı disk/WAL | S-M | P1 |
| P3 | MinIO S3 adaptörü (`object-storage.ts` uygulaması) + koşullu yazma/multipart doğrulaması | M | P1 |
| P4 | Node çalışma zamanı + build boru hattı (vinext → node hedefi) + cron runner | M | P1 |
| P5 | Kimlik: ters vekil + SSO entegrasyonu, production'da kapalı kabul bypass'ı, başlık sözleşmesi ve ağ kapatma | M | P4 |
| P6 | Konteynerleştirme + SHA/SBOM kapılı kurum içi CI/CD (self-hosted runner) + sır yönetimi | M | P4 |
| P7 | Python servisleri, ClamAV aynası, yeniden başlatma ve CPU/bellek/süreç sınırları | S-M | P6 |
| P8 | Kabul ortamı kurulumu (runbook fazları MinIO'ya) + 19 testin yeniden koşusu | M | P2-P7 |
| P9 | (2. dalga, opsiyonel) PostgreSQL geçişi + arama iyileştirmesi | L | P8 sonrası |

S ≈ günler, M ≈ 1-2 hafta, L ≈ 1+ ay tek geliştirici varsayımıyla; P2/P3/P4
paralel yürüyebilir.

## 6. Riskler ve açık kararlar

| Risk / karar | Not |
|---|---|
| MinIO koşullu yazma desteği | `If-None-Match: *` ilk-yazma sözleşmesi T-01'in temelidir; hedef MinIO sürümünde doğrulanmalı (P3'ün ilk işi, kabul yürütücüsü hazır probdur) |
| SSO başlık sahteciliği | `oai-*` başlıkları yalnız ters vekilden gelebilmeli; uygulamaya doğrudan ağ erişimi kapatılmalı (P5 çıkış ölçütü) |
| `node:sqlite` eşzamanlılık | Tek süreç + WAL yeterli; çok replika istenirse 2. dalga (PostgreSQL) öne çekilir |
| ClamAV imza güncellemesi | Kurum içi ağda `freshclam` için imza aynası gerekir; tarama servisi imza 24 saatten eskiyse fail-closed |
| 2 GiB akış profili | Node tarafında Web Streams ile uçtan uca akış korunmalı; K-6 bellek disiplini testi regresyon bekçisidir |
| Donanım/kapasite | İş Etki Analizi (tasarım belgesi açık kararı): depolama büyüme, RPO/RTO, ikinci hata alanının fiziksel yeri |
| KVKK/veri yerleşimi | Kurum içi portun ana gerekçesi; pilotta yalnız sentetik veri kullanılmış olması denetim notu olarak kayda geçirilmeli |

## 7. Kapsam dışı (bilinçli)

- Mevcut belediye sistemleriyle (EBYS, kent bilgi sistemi, ada/parsel servisleri)
  **entegrasyon**: varlık modeli (PARCEL/ADDRESS/BUILDING) hazırdır ama dış
  sistem bağlantıları ayrı bir analiz ve faz gerektirir.
- OpenSearch/tam metin arama iyileştirmesi ve PostgreSQL geçişi (2. dalga, P9).
- Üretim dosya planı saklama süreleri, KMS/anahtar sahipliği gibi kurumsal
  onay kararları (S3 politikası "üretim öncesi kararlar" listesi).
