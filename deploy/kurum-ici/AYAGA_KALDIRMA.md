# Yığını Ayağa Kaldırma (P7 Runbook'u)

Bu runbook, kurum içi yığının bir Docker makinesinde SIFIRDAN ayağa
kaldırılmasını, bileşen bileşen doğrulanmasını ve kalıcılaştırılmasını anlatır.
Kapsam belgesi: `KURUM_ICI_PORT_KAPSAMI.md`; SSO: `sso/README.md`; kabul
koşusu: `KABUL_ORTAM_KURULUMU.md`.

## 0. Ön koşullar

| Gereksinim | Not |
|---|---|
| Linux makine (x86_64), 4+ çekirdek, 8+ GB RAM | OCR modeli bellek ister; disk: arşiv büyümesi + MinIO için ayrı birim |
| Docker Engine + docker compose **>= 2.24** | SSO kaplaması `!override` etiketi kullanır |
| Dışa açık tek port | Vekil portu (vars. 8080); önünde kurum TLS sonlandırıcısı önerilir |
| DNS | `arsiv.sivas.bel.tr` → bu makine (SSO yönlendirmeleri için) |
| İnternet ya da kurum içi aynalar | İlk imaj derlemesi + ClamAV imzaları (kapalı ağ: §5) |

## 1. Hazırlık

```bash
git clone <repo> && cd <repo>/deploy/kurum-ici
cp .env.example .env
```

`.env` doldurma — her sır ayrı üretilir:

```bash
openssl rand -hex 32   # MINIO_ROOT_PASSWORD
openssl rand -hex 32   # ARCHIVE_S3_SECRET_ACCESS_KEY
openssl rand -hex 32   # CONTENT_SCAN_S3_SECRET_ACCESS_KEY
openssl rand -hex 32   # OCR_S3_SECRET_ACCESS_KEY
openssl rand -hex 32   # DOCUMENT_RENDER_S3_SECRET_ACCESS_KEY
openssl rand -hex 32   # ARCHIVE_MIGRATION_TOKEN
openssl rand -hex 32   # CONTENT_SCAN_SERVICE_TOKEN
openssl rand -hex 32   # OCR_SERVICE_TOKEN
openssl rand -hex 32   # DOCUMENT_RENDER_SERVICE_TOKEN
openssl rand -hex 32   # ACCEPTANCE_PROXY_TOKEN (SSO kaplaması için şimdiden)
openssl rand -hex 32   # ARCHIVE_BACKUP_S3_SECRET_ACCESS_KEY
openssl rand -hex 32   # ALARM_WEBHOOK_TOKEN
openssl rand -hex 32   # SQLITE_PITR_S3_SECRET_ACCESS_KEY
```

- `ARCHIVE_CANONICAL_HOST`: kullanıcıların göreceği alan adı
  (ör. `arsiv.sivas.bel.tr`). Bu değer localhost yerel-pilot dolgusunu kapalı
  tutar; `127.0.0.1` YAPMAYIN.
- `ARCHIVE_ADMIN_EMAILS`: ilk yöneticiler (virgülle); ilk girişte `admin`
  rolüyle bootstrap olurlar.
- `APP_ENV`: kabul koşusu yapılacak ortamda `staging` (kanıt ucu yalnız
  staging'de açılır); üretimde `production`.
- `ARCHIVE_WORM_RETENTION_DURATION`: örnekteki `1d` yalnız sentetik staging
  verisi içindir. Üretimde kurum dosya planındaki onaylı `Nd`/`Ny` değeri
  yazılır ve ancak karar kaydı tamamlandıktan sonra
  `ARCHIVE_WORM_POLICY_APPROVED=approved-production-policy` yapılır. Bu karar
  olmadan üretim bilinçli olarak açılmaz.
- MinIO kullanıcı adları ve dört MinIO sırrı birbirinden farklı, sırlar en az
  32 karakter olmalıdır.
- Üretimde nesne yedeği, SQLite PITR ve alarm bölümleri boş bırakılamaz. İki
  yedek ucu hem birincilden hem birbirinden farklı hata alanlarında; üç
  depolama kimliği ve sırları birbirinden farklı olmalıdır.

Dağıtımdan önce dosyanın değerlerini loglamayan kapıyı çalıştırın:

```bash
DEPLOY_ENV=staging ONPREM_ENV_FILE="$PWD/.env" \
  node ../../scripts/validate-onprem-runtime-env.mjs
```

## 2. İlk açılış (temel yığın, SSO'suz)

```bash
docker compose --project-name sivas-arsiv up -d --build
```

Doğrulama sırası (her adım bir öncekine bağlıdır):

| # | Kontrol | Komut | Beklenen |
|---|---|---|---|
| 1 | MinIO sağlıklı | `docker compose ps minio` | `healthy` |
| 2 | WORM + IAM kuruldu | `docker compose logs minio-init` | "MinIO WORM ve rol bazlı IAM kurulumu tamam"; `arsiv-asil` COMPLIANCE kilitli |
| 3 | API açıldı + göçler | `docker compose logs api \| grep node.server-started` | `url=http://0.0.0.0:8788` |
| 4 | UI açıldı | `docker compose ps ui` | `healthy`; `curl -I http://127.0.0.1:8080/archive` HTML yanıtı verir |
| 5 | Tarayıcı imzaları | `docker compose logs content-scan \| grep freshclam` | "imza guncellemesi tamam" (ilk sefer dakikalar sürebilir) |
| 6 | OCR modeli | `docker compose ps ocr` | `healthy` (model indirme ilk açılışta uzun sürebilir) |
| 7 | Render servisi | `docker compose ps document-render` | `healthy` |
| 8 | Vekil + sağlık ucu | `curl -s http://127.0.0.1:8080/api/health` | `status: ready` (hepsi sağlıklıyken) |
| 9 | Render imaj özeti | CI dağıtımında `renderer-image-digest.txt`; yerel pilotta `docker image inspect` | API sağlık denetimindeki özet, çalışan renderer'ın registry özetiyle birebir eşit |

> 7. adım `degraded` dönüyorsa `checks` alanı hangi bileşenin bekletildiğini
> söyler; 4-6. adımlar tamamlanmadan `ready` beklenmez.

## 3. Duman testi

```bash
./smoke.sh
```

Kanıtladıkları: gerçek kabul akışı (oturum → parça → tamamlama), karantina
SHA'sının yerel özetle eşitliği, tarama + terfi zamanlayıcısının işlemesi,
ACCEPTED terminali (tekrar koşuda DUPLICATE — tekilleştirme kanıtı) ve
MinIO'daki fiziksel nesneler. Başarısızlıkta adım adı ve ipucu basar.

## 4. SSO + TLS kaplaması

`sso/README.md` izlenir; özetle: Keycloak (kurumsal ya da `--profile
kimlik-yerel`), `.env` SSO bölümü, sonra:

```bash
docker compose -f docker-compose.yml -f docker-compose.sso.yml \
  -f docker-compose.tls.yml up -d --build
curl -k -s -o /dev/null -w '%{http_code}\n' \
  https://127.0.0.1/api/documents   # 302 → girişe yönlendirme
```

Vekil açılmıyorsa ilk bakılacak yer: `ACCEPTANCE_PROXY_TOKEN` boş — bu
bilinçli fail-closed'dur (şablon çift map anahtarı üretir).

## 5. Kapalı ağ notları

- **İmajlar**: derlemeler internet ister; kapalı ağda imajlar kurum kayıt
  defterinden (registry) çekilecek şekilde CI'da derlenip itilir.
- **ClamAV**: `FRESHCLAM_MIRROR` .env'e kurum içi ayna adresi yazılır
  (cvdupdate ile beslenen basit HTTP sunucusu yeterli). İmza 24 saatten
  eskirse tarayıcı fail-closed kapanır ve kabul `SCANNING`'de bekler — bu bir
  arıza değil güvenlik davranışıdır.
- **OCR modeli**: ilk açılışta indirilir; kapalı ağda model dosyaları imaja
  gömülür ya da birim olarak taşınır (`services/ocr/README.md`).

## 6. Kalıcılaştırma

Açılışta otomatik başlama (systemd):

```ini
# /etc/systemd/system/sivas-arsiv.service
[Unit]
Description=Sivas Dijital Arsiv (docker compose)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=/opt/sivas-arsiv/deploy/kurum-ici
ExecStart=/usr/bin/docker compose --env-file .env -f docker-compose.yml -f docker-compose.sso.yml -f docker-compose.tls.yml up -d
ExecStop=/usr/bin/docker compose --env-file .env -f docker-compose.yml -f docker-compose.sso.yml -f docker-compose.tls.yml stop

[Install]
WantedBy=multi-user.target
```

Yedekleme (İş Etki Analizi RPO/RTO kararına bağlanır):

- **Uygulama yedek dilimi (ADR-017)**: `.env` içinde `ARCHIVE_S3_BUCKET_BACKUP`
  (ve ikinci hata alanı için `ARCHIVE_BACKUP_S3_ENDPOINT` + ayrı
  `ARCHIVE_BACKUP_S3_ACCESS_KEY_ID/_SECRET_ACCESS_KEY`) tanımlanınca bakım
  turu saatte bir asıl nesneleri artımlı kopyalar, günde bir üst veri dökümü
  ve nesne manifesti üretir; durum `backup_runs` defterinde ve panoda görünür.
  Üretim çalışma zamanı, yedek ucu/kimliği birincille aynıysa veya HTTPS değilse
  açılmaz. Dağıtım kapısı ayrıca boş/çok kısa sırları reddeder.
- **SQLite PITR**: `COMPOSE_PROFILES=pitr` ile Litestream sidecar aynı yerel
  `api-veri` birimini izler ve LTX akışını ikinci S3 hata alanına 10 saniyelik
  teknik aralıkla çoğaltır. Kalp atışı yalnız başarılı eşitlemeden sonra gider;
  kaçırılan kalp atışı alarmdır. NFS/SMB veya makineler arası paylaşılan SQLite
  dosyası kullanılmaz. Ayrıntılı politika ve canlı dosyaya dokunmayan geri
  yükleme tatbikatı: `litestream/README.md`.
- **MinIO**: ikinci makineye `mc mirror --watch` ya da site replication;
  `arsiv-asil` için sürümler ve Object Lock hedefte de korunmalıdır.
- **Alarm**: `ALARM_WEBHOOK_URL` tanımlanırsa bütünlük bulgusu, OCR
  dead-letter artışı ve yedek arızası bu uca JSON POST edilir; tanımsızsa
  olaylar yalnız log'da kalır.
- Geri yükleme tatbikatı her sürüm yükseltmesinde ve kurumsal takvimde T-09
  yürütücüsüyle, temsili veri boyutunda koşulur. Başarılı kanıt olmadan üretim
  onay işareti verilemez.

## 7. Sorun giderme

| Belirti | Muhtemel neden | Çözüm |
|---|---|---|
| `proxy` açılmıyor, "duplicate ... map" | `ACCEPTANCE_PROXY_TOKEN` boş | `.env`'e >= 32 karakter jeton yazın (bilinçli fail-closed) |
| Sağlık `degraded`, `contentScan.ok=false` | İmzalar eski/iniyor | `docker compose logs content-scan`; ayna erişimini doğrulayın |
| Oturum `SCANNING`'de kalıyor | Tarayıcı fail-closed ya da servis jetonu uyumsuz | İmza yaşı + `CONTENT_SCAN_SERVICE_TOKEN` eşitliği |
| Oturum `VERIFIED`'da kalıyor | Terfi zamanlayıcısı | `docker compose logs api \| grep cron.promotion` |
| Kimlikli istek 401 | Vekil başlığı silip SSO'suz enjekte etmiyor | Beklenen davranış: SSO bağlayın ya da smoke.sh gibi konteyner içinden test edin |
| `putIfAbsent` beklenmedik davranıyor | MinIO sürümü koşullu yazmayı desteklemiyor | MinIO'yu güncelleyin; kabul T-01 probu nihai hakemdir |
| API açılmıyor: `ARCHIVE_S3_* zorunludur` | `.env` eksik | İlgili değişkeni doldurun (fail-closed açılış) |
| `minio-init` benzersiz kimlik/sır hatası | Eski `.env` tek MinIO kimliğini paylaştırıyor | `.env.example` içindeki dört kimliği ve dört ayrı 32+ karakter sırrı doldurun |
| `minio-init` üretim WORM onayı hatası | Onaylı dosya planı süresi yok | Süreyi teknik ekip uydurmaz; kurum kararını tamamlayın, onaylı süreyi yazın ve onay işaretini açın |
| Dağıtım `PITR_*` koduyla kapanıyor | İkinci hata alanı, ayrı kimlik, heartbeat ya da tatbikat kanıtı eksik | `.env.example` PITR bölümünü doldurun; `litestream/README.md` tatbikatını tamamlayın |
| `litestream` sağlıksız | Yerel DB görülmüyor, S3/TLS erişimi veya dar IAM eksik | `docker compose --profile pitr logs litestream`; heartbeat ve hedef politika kanıtını inceleyin |

### MinIO sır döndürme notu

`minio-init` mevcut kullanıcıyı silmez; böylece her yeniden başlatma çalışan
erişimi kesmez. Bir MinIO sırrı değiştirilecekse bakım penceresinde ilgili
servis durdurulur, kullanıcı `mc admin user rm` ile kaldırılır, `.env` sırrı
değiştirilir ve `minio-init` yeniden çalıştırılır. Sonra yalnız ilgili servis
açılıp sağlık kontrolü yapılır.

## 8. Sonraki adım: kabul koşusu (P8)

Yığın `ready` + duman testi geçtikten sonra `KABUL_ORTAM_KURULUMU.md`
fazlarındaki uçlar bu yığına çevrilir (MinIO TLS'li dış uç, `s3-object-lock`
profili, ikinci MinIO, `ACCEPTANCE_PROXY_TOKEN`) ve 19 testlik koşu
tetiklenir. Teknik kapı yeniden açılana kadar port "bitti" sayılmaz.

## 9. CI/CD ve geri alma

`.github/workflows/deploy-onprem.yml` elle ve korumalı GitHub environment
onayıyla çalışır. Beş uygulama imajını `ghcr.io/<repo>/<bileşen>:<commit-sha>`
olarak üretir; `latest` kullanılmaz. Dağıtım işi yalnız
`self-hosted, linux, onprem-archive` etiketli kurum runner'ında çalışır.

`onprem-staging` ve `onprem-production` environment'larında:

- secret: `DEPLOY_BASE_URL`, `ARCHIVE_MIGRATION_TOKEN`,
- variable: `ONPREM_ENV_FILE` (runner üzerindeki mutlak `.env` yolu),
  `ONPREM_RELEASE_STATE_FILE` (başarılı SHA'nın tutulduğu mutlak yol),
  isteğe bağlı `ONPREM_PROJECT_NAME`

tanımlanır. `.env` dosyası sürüm kontrolüne girmez ve world-readable olamaz.
MinIO, `mc`, nginx, oauth2-proxy ve Litestream imajları korumalı ortamda
`repo@sha256:<64-hex>` biçiminde sabitlenir; hareketli etiket runtime ön
kontrolünde dağıtımı durdurur. Özetler kurumun onaylı registry aynasından
alınmalı ve değişiklik kaydıyla güncellenmelidir.
Dağıtım SSO ve TLS kaplamalarını zorunlu bağlar; sertifika/anahtar yolları,
OIDC callback ve güvenli çerez ayarları `.env` içinde doğrulanmadan rollout
başlamaz. Anahtar dosyası world-readable ise kapı kapanır.
Dağıtım sonrası göç + readiness çalışır; sağlık yanıtındaki gerçek
`releaseRevision` beklenen commit SHA ile eşleşmezse kapı kapanır. Başarısız
koşu, durum dosyasındaki önceki SHA'ya döner ve doğrulamayı yeniden çalıştırır.
Rollout, renderer imajını çektikten sonra gerçek GHCR `RepoDigest` değerini
Docker'dan çözer; API ile renderer'a aynı değeri enjekte eder. Sağlık ucu bu
değeri renderer'ın profil/sürüm yanıtıyla karşılaştırır ve kanıt paketine
`renderer-image-digest.txt` olarak ekler; elle yazılmış `.env` değeri CI
dağıtımında güven kaynağı değildir.
Her beş uygulama imajı yayımlanmadan önce SPDX JSON SBOM'a dönüştürülür ve
giderilebilir `critical` zafiyetlerde build kapanır. Tarayıcı araç action'ları
hareketli etiketle değil tam commit SHA ile sabittir; SBOM ve zafiyet JSON'ları
`onprem-images-*` kanıt paketinde saklanır. Ana CI ayrıca content-scan, OCR ve
document-render Python regresyonlarının üçünü de çalıştırır.

Yeni yükleme oturumu, fiziksel arşiv+türev+karantina kullanımı ile açık
yükleme rezervasyonlarını tek atomik SQL kararında toplar. Kurumsal kotanın
%95 kritik bandına yeni dosyayla girilecekse API `507
STORAGE_QUOTA_EXCEEDED` döndürür; mevcut/idempotent oturumlar etkilenmez ve
türev/işletim işleri için %5 güvenlik payı korunur.
İlk dağıtımdan önce geri dönülecek sürüm olmadığı için staging pilotu başarıyla
tamamlanıp durum dosyası oluşmadan production dağıtımı yapılmaz.
