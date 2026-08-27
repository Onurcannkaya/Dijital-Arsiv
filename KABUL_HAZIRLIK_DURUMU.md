# Kabul Koşusu Hazırlık Durumu — 2026-08-26

> **Yerleşim kararı (2026-08-14): kabul koşusu KURUM İÇİ staging'e karşı
> koşulacak.** Üretim hedefi ADR-018 gereği kurum içidir; kabul kanıtının
> üretimi temsil etmesi için staging de aynı yerleşimde kurulur
> (`deploy/kurum-ici/AYAGA_KALDIRMA.md` compose yığını + MinIO).
> `KABUL_ORTAM_KURULUMU.md` içindeki Cloudflare/R2 örnekleri, aşağıdaki
> §6 eşlemesiyle MinIO karşılıklarına çevrilir. Cloudflare yolu terk
> edildi; staging ortamındaki eski `CLOUDFLARE_API_TOKEN` kullanılmayacak.

## 6. Kurum içi yol — tek kalem eksik listesi (aşama aşama)

**Aşama 1 · Sunucu temini** — *Bilgi İşlem; tek gerçek dış bağımlılık*
- Linux x86_64, 4+ çekirdek, 8+ GB RAM (OCR için 16 önerilir), arşiv +
  MinIO için ayrı disk birimi
- Docker Engine + compose ≥ 2.24; dışa açık tek vekil portu + kurum TLS
  sonlandırıcısı; DNS: staging için ör. `arsiv-staging.sivas.bel.tr`
- İnternet erişimi ya da kurum içi aynalar (ilk imaj + ClamAV imzaları)
- **Karar gerekiyor:** GitHub Actions koşucusunun staging'e erişimi —
  (a) staging DMZ'de internete açık, ya da (b) kurum ağında self-hosted
  GitHub runner. İkisinden biri olmadan workflow staging'e ulaşamaz.

**Aşama 2 · Yığını ayağa kaldırma** — *sunucu gelince, AYAGA_KALDIRMA adım adım*
- `.env`: 7 sır `openssl rand -hex 32` ile üretilir; `APP_ENV=staging`
  (kanıt ucu yalnız staging'de açılır); `ARCHIVE_CANONICAL_HOST` staging
  alan adı; `ARCHIVE_ADMIN_EMAILS` ilk yöneticiler
- `ARCHIVE_ACCEPTANCE_BYPASS_ENABLED=enabled`; production'da bu değer
  `disabled`, `ACCEPTANCE_PROXY_TOKEN` ise boş olmak zorundadır
- `ARCHIVE_ACCEPTANCE_TOKEN` da üretilip `.env`'e girilir (GitHub'dakiyle
  AYNI değer olacak)
- `docker compose up -d --build` → 8 doğrulama adımı → `./smoke.sh`
- Sentetik yükleyici kullanıcısı API'den açılır: `kabul-yukleyici@sivas.bel.tr`,
  rol `archive_manager`, müdürlük "Kabul Testleri"

**Aşama 3 · GitHub kabul girdileri (Faz B)** — *değerler sunucudan; komutlar runbook'ta*
- `ACCEPTANCE_BASE_URL` = staging HTTPS adresi
- `ARCHIVE_ACCEPTANCE_TOKEN` + `ARCHIVE_MIGRATION_TOKEN` = `.env`'dekiyle aynı
  (11 Ağustos'ta girilenler compose sırlarıyla eşleşmiyorsa GÜNCELLENİR)
- `ACCEPTANCE_UPLOADER_IDENTITY` = `kabul-yukleyici@sivas.bel.tr`
- SSO kaplaması kuruluysa `ACCEPTANCE_PROXY_TOKEN` (.env ile aynı)
- → 8 çekirdek test koşar (K-1..K-3, K-7, T-02/03/05/12)

**Aşama 4 · S3/IAM girdileri (Faz C+D, MinIO karşılıkları)**
- Uç: `ACCEPTANCE_S3_ENDPOINT` = MinIO adresi; kovalar: `arsiv-asil`,
  `arsiv-karantina`; bölge `us-east-1`
- Birincil dar kimlik + 4 rol kimliği `mc admin user add` + kova-kapsamlı
  `mc admin policy` ile açılır (kapsam matrisi `KABUL_ORTAM_KURULUMU.md` §5;
  SCANNER=karantina salt-okur, OCR=asıl salt-okur, VIEWER/APPLICATION=erişimsiz)
- → T-01, T-04/05/06, T-08, K-4 açılır

**Aşama 5 · İleri fazlar (E–G, MinIO karşılıkları)**
- T-07: `arsiv-asil` zaten Object Lock'lu kurulur (compose `minio-init`);
  kilit prob kimlikleri + `LOCKED/UNLOCKED_PREFIX` tanımlanır
- T-09: izole geri yükleme kovası + RTO 8 saat (ADR-018)
- T-10: ikinci sağlayıcı — ayrı MinIO örneği ya da farklı hesapta S3;
  birinciden gerçekten farklı adaptör olmalı
- T-11 / K-6: staging API'sinin kimlik doğrulamalı, production'da görünmeyen
  kabul gözlemlenebilirlik ucu hazırdır. Aynı HTTPS yol `kind=logs` ve
  `kind=resources` sorgularıyla kullanılır; kalıcı SIEM/izleme yerine geçmez.
- K-5/K-6 anahtarları: `ACCEPTANCE_FAULT_INJECTION` / `ACCEPTANCE_LARGE_FIXTURES`

**Aşama 6 · İmzalı Faz 0 bağı ve koşu**
- Başarılı dağıtımın imzalı kanıtı + arşivlenmiş pilot oturum,
  `phase-zero-evidence.yml` ile canlı kayıtlardan doğrulanır
- Üretilen Faz 0 workflow run kimliği Faz 1'in `phase_zero_run_id` girdisine
  verilir; özet ve provenance otomatik doğrulanır
- Açık kritik/yüksek bulgu sayıları; environment onaycıları (runbook §1)
- `phase-one-acceptance.yml` tetiklenir; BLOCKED listesi yalnız bilinçli
  kapalı fazları göstermelidir

### Bilgi İşlem'e sunucu istek özeti (kopyalanabilir)

> Dijital Arşiv kabul ortamı için: Linux x86_64 sanal makine, 4 çekirdek /
> 16 GB RAM / sistem diski + arşiv için ayrı 200+ GB birim; Docker Engine ve
> docker compose ≥ 2.24 kurulu; `arsiv-staging.sivas.bel.tr` DNS kaydı bu
> makineye; kurum TLS sonlandırıcısı arkasında tek port (8080) dışa açık;
> ClamAV imza güncellemeleri için internet erişimi ya da kurum içi ayna.
> Ayrıca GitHub Actions'ın bu ortama erişimi için tercih bildirilmeli:
> DMZ'de internete açık staging YA DA kurum ağında self-hosted runner.

Bu belge, Faz 1 kabul koşusu (`KABUL_ORTAM_KURULUMU.md`) öncesinde **kod
tarafının hazır olduğunu kanıtlayan yerel provanın** sonuçlarını ve koşunun
açılması için kurum/işletim tarafında bekleyen girdilerin envanterini tutar.
Koşu tetiklenmeden önce bu envanterdeki her satır kapatılmalı ya da bilinçli
olarak BLOCKED bırakılacağı kabul edilmelidir.

## 1. Yerel prova sonuçları (bu depo, bu makine)

| Prova | Sonuç |
|---|---|
| Tam kalite kapısı (`npm run verify`) | **PASS** — typecheck + lint + build + **534/534 test** (2026-08-26) |
| Bağımlılık güvenliği | **0 bulgu** — üretim ve tam geliştirme ağacı (`npm audit`, 2026-08-26) |
| Şema | v33; kabul workflow'u sürümü elle tutmaz, canlı staging ön kontrolünden alır |
| Kabul hattı kuru koşusu (`run-phase-one-acceptance.mjs`, yeteneksiz) | Manifest üretildi; 19 testin 19'u **dürüstçe BLOCKED**, teknik kapı gerekçeleriyle kapalı (`EXIT_PHASE_ZERO_NOT_PROVEN`, `EXIT_*_FINDINGS_OPEN`, `BLOCKED:*`) |
| Yürütücü modülü | `scripts/acceptance-executors/pipeline.mjs` repoda; sahte-S3/sahte-staging karşılığındaki yürütücü testleri tam takımda yeşil |

Kuru koşu, boru hattının ve manifest/kanıt sözleşmesinin bu depo sürümüyle
çalıştığını kanıtlar: koşu açıldığında sürpriz, yalnız ortam girdilerinden
gelebilir.

## 2. Koşu öncesi güncellenmesi ZORUNLU değerler

- `ACCEPTANCE_SCHEMA_VERSION` artık ayarlanmaz; canlı dağıtım ön kontrolü
  `schema_version` çıktısını koşuya verir. Eski v28 environment değişkeni
  etkisizdir ve kaldırılabilir.
- `ACCEPTANCE_GIT_COMMIT` — koşulan dağıtımın gerçek SHA'sı (workflow verir).
- `DEPLOY_BASE_URL` / `ACCEPTANCE_BASE_URL` — staging worker adresi.

## 3. Ortam girdileri envanteri (KABUL_ORTAM_KURULUMU fazları)

| Faz | Açtığı testler | Girdiler | Sahibi | Durum |
|---|---|---|---|---|
| A — Dağıtım | (ön koşul) | Kurum içi staging makinesi, TLS/DNS, compose sırları ve erişebilen runner | Bilgi İşlem | Bekliyor |
| B — Kabul çekirdeği | K-1, K-2, K-3, K-7, T-02, T-03, T-05, T-12 | `ACCEPTANCE_BASE_URL`, kabul/göç jetonları, sentetik yükleyici (rol: `archive_manager`, müdürlük: "Kabul Testleri") | Bilgi İşlem + Arşiv | Bekliyor |
| B.1 — Kapı kanıtı | teknik kapı | İmzalı Faz 0 workflow run kimliği + açık kritik/yüksek bulgu sayıları | Bilgi Güvenliği | Bekliyor |
| C — Birincil S3 | T-01, T-08, K-5 ön koşulu | R2/S3 uç + kova + dar kimlik | Bilgi İşlem | Bekliyor |
| D — IAM ayrımı | T-04, T-05, T-06, K-4 | 2 uygulama kimliği + 4 rol için S3 üçlüleri (kapsam matrisi runbook §5) | Bilgi İşlem | Bekliyor |
| E — Değişmezlik kilidi | T-07 | Object Lock/bucket-lock pilotu kovası + prob kimlikleri | Bilgi İşlem | Bekliyor |
| F — Yedek/taşınabilirlik | T-09, T-10 | Geri yükleme kovası (RTO 8 saat, ADR-018) + ikinci sağlayıcı (gerçekten farklı adaptör) | Bilgi İşlem | Bekliyor |
| G — Log/metrik/anahtar | T-11, K-5, K-6 | Staging kabul gözlemlenebilirlik URL'leri hazır; GitHub girdileri, büyük veri/hata enjeksiyonu anahtarları | Bilgi İşlem | Ortam girdisi bekliyor |

Fazlar kademelidir: yalnız A+B kurulunca 8 test koşar, kalanı BLOCKED kalır
ve bu bir hata değildir — koşu eksikliği dürüstçe raporlar.

### 2026-08-25 GitHub environment denetimi

- Depo düzeyinde sır/değişken yoktur.
- `staging`: yalnız `CLOUDFLARE_API_TOKEN` ve `ARCHIVE_MIGRATION_TOKEN` vardır;
  eski Cloudflare yolu kullanılacaksa `CLOUDFLARE_ACCOUNT_ID` ve
  `DEPLOY_BASE_URL`, kurum içi yol kullanılacaksa ayrı dağıtım workflow'u/runner
  gerekir.
- `phase-one-acceptance`: yalnız `ARCHIVE_ACCEPTANCE_TOKEN`,
  `ARCHIVE_MIGRATION_TOKEN` ile üç değişken vardır. Canlı çekirdek koşu için
  dahi `ACCEPTANCE_BASE_URL` ve `ACCEPTANCE_UPLOADER_IDENTITY` eksiktir;
  19/19 için C–G girdileri de kurulmalıdır.
- Faz 1 kabul workflow'u henüz canlı çalıştırılmamıştır. Bu durum kod hatası
  değil, ortam kurulumunun açık olduğunun kanıtıdır.
- Kurum içi dağıtımın imzalı kanıtını üreten
  `.github/workflows/deploy-onprem.yml` repodadır: SHA imajları, SBOM/kritik
  açık kapısı, SSO/TLS, göç/readiness, sürüm doğrulama ve rollback bağlıdır.
  Henüz gerçek kurum runner'ında başarılı canlı koşu kanıtı yoktur.

## 4. Kurumsal ön koşullar (teknik değil)

- **ADR-016 saklama/dosya planı onayı:** `FILE_PLAN` ve `RETENTION_RULE`
  sözlükleri TASLAK tohumlarla çalışıyor (PR #47); üretim aslının
  kilitlenmesi öncesinde kurumun onaylı Standart Dosya Planı ve saklama
  planı ayarlardaki sözlük yönetiminden işlenmelidir. Kabul koşusu sentetik
  veriyle koştuğundan koşuyu ENGELLEMEZ; üretim kapısını engeller.
- Environment onaycıları (runbook §1): `phase-one-acceptance` için Bilgi
  Güvenliği + Arşiv temsilcisi.
- `ACCEPTANCE_APPROVALS_JSON` release kapısı imzaları manifest özetine
  bağlanır; koşudan SONRA toplanır.

## 5. Bilinen ortam sınırları

- Bu geliştirme makinesi Docker'sızdır; `AYAGA_KALDIRMA.md` compose yığını
  (gerçek ClamAV/qpdf/MinIO/document-render) ayrı bir makinede kurulur.
  Yerel zincir eşleniği (`LOKAL_GELISTIRME.md`) geliştirme içindir ve kabul
  kanıtı yerine geçmez.
- OCR servisi işletim notu: uzun ömürlü süreç yavaşlayabilir (aynı görüntü
  45 sn → 359 sn ölçüldü); staging kurulumunda `OCR_PRELOAD_MODEL=true`
  zorunlu ve periyodik süreç tazeleme önerilir (PR #43 ısınma düzeltmesiyle
  birlikte).
