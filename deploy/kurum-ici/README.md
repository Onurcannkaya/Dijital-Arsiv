# Kurum İçi Yığın (P6 Referans Kurulumu)

Tek makinelik referans kurulum: MinIO + Node API + üç Python servisi + kimlik
sınırı ters vekili. Kapsam belgesi: `KURUM_ICI_PORT_KAPSAMI.md`; kabul ortamı
değişkenleri: `KABUL_ORTAM_KURULUMU.md`.

## Kurulum

Adım adım runbook: `AYAGA_KALDIRMA.md` (ön koşullar, doğrulama sırası,
duman testi `./smoke.sh`, SSO, kalıcılaştırma ve sorun giderme). Kısa yol:

```bash
cd deploy/kurum-ici
cp .env.example .env      # sırları doldurun: openssl rand -hex 32
docker compose up -d --build
./smoke.sh
```

Sağlık yanıtı ilk açılışta `degraded` olabilir: OCR modeli ve ClamAV imzaları
iniyordur; `docker compose ps` sağlık sütununu izleyin.

## Mimarinin güvenlik sınırları

- **Kimlik**: Uygulama `oai-authenticated-user-email` başlığına güvenir; bu
  başlığı YALNIZ ters vekil verebilir (`nginx.conf` istemci başlıklarını
  koşulsuz siler). SSO bağlanana kadar vekil kimliksiz istekleri kimliksiz
  bırakır ve uygulama 401 döner. SSO katmanı hazırdır:
  `docker-compose.sso.yml` kaplaması oauth2-proxy + Keycloak bağlar
  (kurulum: `sso/README.md`).
- **Ağ**: API, MinIO ve servisler yalnız `arsiv-ic` ağındadır; dışarıya tek
  kapı vekilin portudur.
- **Değişmezlik**: `arsiv-asil` kovası sürümleme + Object Lock ile açılır
  (gerçek WORM, ADR-016). ADR-018 Karar 5 gereği ilk üretim döneminde tasfiye
  KAPALIDIR: varsayılan bekletme tanımlanmaz, tasfiye kimliği açılmaz; sınıf
  bazlı bekletme dosya planı eşlemesi sonrası yeni ADR ile gelir.
- **SQLite verisi** `api-veri` birimindedir; yedeği dosya kopyasıyla değil
  önce `checkpoint` (kapanış) sonra birim anlık görüntüsüyle alın.

## IAM (üretim öncesi zorunlu sıkılaştırma)

`minio-init` başlangıç için TEK uygulama kullanıcısına `readwrite` verir. Bu,
ADR-014 rol ayrımını KARŞILAMAZ. Üretim ve kabul koşusu öncesi:

1. Rol başına kullanıcı: uygulama (gecici+karantina rw, asıl koşullu yazma,
   turev rw), scanner (yalnız karantina okuma), ocr (yalnız asıl okuma),
   viewer probu (hiçbir kovaya erişim yok).
2. `mc admin policy create` ile dar politikalar; K-4/T-06 kabul testleri bu
   ayrımı fiilen doğrular.

## ClamAV imza aynası

Tarama servisi imza veritabanı 24 saatten eskiyse fail-closed kapanır. Kapalı
ağda `freshclam` için kurum içi bir ayna (ör. cvdupdate ile beslenen HTTP
sunucusu) tanımlanmalı ve konteynere `FRESHCLAM_MIRROR` olarak verilmelidir.

## Kabul koşusu (P8)

`KABUL_ORTAM_KURULUMU.md` fazlarındaki S3 uçları bu yığına çevrilir:
`ACCEPTANCE_S3_ENDPOINT` → MinIO'nun TLS'li dış ucu, kilit profili →
`s3-object-lock`, ikinci sağlayıcı → ayrı makinedeki ikinci MinIO. İlk iş
T-01 koşullu yazma probudur (MinIO sürüm doğrulaması).

## Bilinçli kapsam sınırları

- UI bu yığında sunulmaz (API-only); UI kararı kapsam belgesinde ayrı iştir.
- MinIO burada tek düğümdür; ikinci hata alanı/çoğaltma ADR-017 kararıyla
  planlanır (İş Etki Analizi).
- Konteyner içi trafik düz HTTP'dir (`ARCHIVE_S3_ALLOW_HTTP=enabled` yalnız
  bu izole ağ için). Makineler ayrışırsa MinIO TLS zorunludur.
