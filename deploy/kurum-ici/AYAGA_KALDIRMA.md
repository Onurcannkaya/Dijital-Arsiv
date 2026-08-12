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
openssl rand -hex 32   # ARCHIVE_MIGRATION_TOKEN
openssl rand -hex 32   # CONTENT_SCAN_SERVICE_TOKEN
openssl rand -hex 32   # OCR_SERVICE_TOKEN
openssl rand -hex 32   # DOCUMENT_RENDER_SERVICE_TOKEN
openssl rand -hex 32   # ACCEPTANCE_PROXY_TOKEN (SSO kaplaması için şimdiden)
```

- `ARCHIVE_CANONICAL_HOST`: kullanıcıların göreceği alan adı
  (ör. `arsiv.sivas.bel.tr`). Bu değer localhost yerel-pilot dolgusunu kapalı
  tutar; `127.0.0.1` YAPMAYIN.
- `ARCHIVE_ADMIN_EMAILS`: ilk yöneticiler (virgülle); ilk girişte `admin`
  rolüyle bootstrap olurlar.
- `APP_ENV`: kabul koşusu yapılacak ortamda `staging` (kanıt ucu yalnız
  staging'de açılır); üretimde `production`.

## 2. İlk açılış (temel yığın, SSO'suz)

```bash
docker compose --project-name sivas-arsiv up -d --build
```

Doğrulama sırası (her adım bir öncekine bağlıdır):

| # | Kontrol | Komut | Beklenen |
|---|---|---|---|
| 1 | MinIO sağlıklı | `docker compose ps minio` | `healthy` |
| 2 | Kovalar kuruldu | `docker compose logs minio-init` | "MinIO kurulumu tamam"; `arsiv-asil` Object Lock'lu |
| 3 | API açıldı + göçler | `docker compose logs api \| grep node.server-started` | `url=http://0.0.0.0:8788` |
| 4 | Tarayıcı imzaları | `docker compose logs content-scan \| grep freshclam` | "imza guncellemesi tamam" (ilk sefer dakikalar sürebilir) |
| 5 | OCR modeli | `docker compose ps ocr` | `healthy` (model indirme ilk açılışta uzun sürebilir) |
| 6 | Render servisi | `docker compose ps document-render` | `healthy` |
| 7 | Vekil + sağlık ucu | `curl -s http://127.0.0.1:8080/api/health` | `status: ready` (hepsi sağlıklıyken) |
| 8 | Render imaj özeti | `docker inspect --format '{{index .RepoDigests 0}}' sivas-arsiv-document-render` | `.env DOCUMENT_RENDER_IMAGE_DIGEST` değerine yazın, `docker compose up -d api` ile yeniden verin |

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

## 4. SSO kaplaması

`sso/README.md` izlenir; özetle: Keycloak (kurumsal ya da `--profile
kimlik-yerel`), `.env` SSO bölümü, sonra:

```bash
docker compose -f docker-compose.yml -f docker-compose.sso.yml up -d --build
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/documents   # 302 → girişe yönlendirme
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
ExecStart=/usr/bin/docker compose -f docker-compose.yml -f docker-compose.sso.yml up -d
ExecStop=/usr/bin/docker compose stop

[Install]
WantedBy=multi-user.target
```

Yedekleme (İş Etki Analizi RPO/RTO kararına bağlanır):

- **SQLite**: `docker compose stop api` → `api-veri` biriminin anlık
  görüntüsü → `start`. (Kapanış WAL checkpoint yapar; canlı kopya İSTENMEZ.)
- **MinIO**: ikinci makineye `mc mirror --watch` ya da site replication;
  `arsiv-asil` için sürümler ve Object Lock hedefte de korunmalıdır.
- Geri yükleme tatbikatı yılda en az bir kez T-09 yürütücüsüyle koşulur.

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

## 8. Sonraki adım: kabul koşusu (P8)

Yığın `ready` + duman testi geçtikten sonra `KABUL_ORTAM_KURULUMU.md`
fazlarındaki uçlar bu yığına çevrilir (MinIO TLS'li dış uç, `s3-object-lock`
profili, ikinci MinIO, `ACCEPTANCE_PROXY_TOKEN`) ve 19 testlik koşu
tetiklenir. Teknik kapı yeniden açılana kadar port "bitti" sayılmaz.
