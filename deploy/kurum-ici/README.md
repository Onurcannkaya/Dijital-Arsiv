# Kurum İçi Yığın (P6 Referans Kurulumu)

Tek makinelik referans kurulum: MinIO + Node API + vinext standalone UI + üç
Python servisi + kimlik sınırı ters vekili. Kapsam belgesi:
`KURUM_ICI_PORT_KAPSAMI.md`; kabul ortamı
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

Üretim yedeği ve SQLite PITR varsayılan yerel yığını etkilemez. Kurulum
kararları tamamlandıktan sonra `.env` içindeki ikinci hata alanı/alarm/kota
değerleri doldurulur ve `COMPOSE_PROFILES=pitr` ile açılır. Dar IAM ve güvenli
geri yükleme tatbikatı `litestream/README.md`, tüm sıra `AYAGA_KALDIRMA.md`
içindedir.

## Mimarinin güvenlik sınırları

- **Kimlik**: Uygulama `oai-authenticated-user-email` başlığına güvenir; bu
  başlığı YALNIZ ters vekil verebilir (`nginx.conf` istemci başlıklarını
  koşulsuz siler). SSO bağlanana kadar vekil kimliksiz istekleri kimliksiz
  bırakır ve uygulama 401 döner. SSO katmanı hazırdır:
  `docker-compose.sso.yml` kaplaması oauth2-proxy + Keycloak bağlar
  (kurulum: `sso/README.md`).
- **Ağ**: UI, API, MinIO ve servisler yalnız `arsiv-ic` ağındadır; dışarıya
  tek kapı vekilin portudur. UI hiçbir DB/depolama sırrı almaz; `/api/`
  trafiğini vekil ayrı API sürecine yollar.
- **Değişmezlik**: `arsiv-asil` kovası sürümleme + Object Lock ile açılır
  ve varsayılan `COMPLIANCE` bekletmesi uygulanır (gerçek WORM, ADR-016).
  Örnekteki `1d` yalnız sentetik staging belgeleri içindir. Üretim,
  dosya planından onaylı süre girilmeden ve
  `ARCHIVE_WORM_POLICY_APPROVED=approved-production-policy` yapılmadan
  fail-closed açılmaz. ADR-018 Karar 5 gereği tasfiye kimliği hâlâ KAPALIDIR.
- **SQLite verisi** `api-veri` yerel Linux birimindedir. `pitr` profili aynı
  birimi izleyerek işlemleri ikinci S3 hata alanına sürekli çoğaltır; canlı DB
  dosyası elle kopyalanmaz ve geri yükleme tatbikatı yalnız ayrı dosyaya yapılır.

## IAM

`minio-init`, sürüm kontrollü politikaları idempotent uygular ve dört ayrı
kimlik oluşturur:

1. Uygulama: geçici/karantina/türev okuma-yazma; asıl okuma ve koşullu yazma.
   Asılda silme, retention/legal-hold yönetimi ve governance bypass yoktur.
2. Tarayıcı: yalnız karantina okuma.
3. OCR: yalnız asıl okuma.
4. Renderer: asıl okuma, türev okuma-yazma; silme yoktur.

Kimlikler ile en az 32 karakterli sırlar benzersiz değilse kurulum durur.
Eski kurulumdaki uygulama kullanıcısına bağlı `readwrite` politikası otomatik
sökülür. K-4/T-06 kabul testleri ayrımı canlı ortamda ayrıca kanıtlar.

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

- MinIO burada tek düğümdür; üretim nesne yedeği ve SQLite PITR hedefleri bu
  makinenin/birincil MinIO'nun dışındaki hata alanlarında kurulmalıdır.
- Konteyner içi trafik düz HTTP'dir (`ARCHIVE_S3_ALLOW_HTTP=enabled` yalnız
  bu izole ağ için). Makineler ayrışırsa MinIO TLS zorunludur.
