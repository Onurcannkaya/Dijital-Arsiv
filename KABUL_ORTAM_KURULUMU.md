# Kabul Ortamı Kurulum Runbook'u (F1.11)

Bu runbook, Faz 1 kabul koşusunun (`.github/workflows/phase-one-acceptance.yml`)
gerçek staging kanıtı üretebilmesi için gereken bütün sır, değişken, ortam ve
kimlik kurulumunu tek yerde toplar. Katalogdaki 19 testin tamamının canlı
yürütücüsü repodadır (`scripts/acceptance-executors/pipeline.mjs`); koşu, bir
yetenek eksikse ilgili testi **dürüstçe `BLOCKED`** bırakır. Bu belgedeki
adımlar tamamlandıkça testler kademeli olarak BLOCKED'dan çıkar.

Sözleşme kaynakları: yetenek tanımları `scripts/phase-one-acceptance-core.mjs`
(`resolveCapabilities`), ortam eşlemesi `scripts/run-phase-one-acceptance.mjs`
(`scopedConfig`), test ölçütleri `FAZ_1_KANIT_REHBERI.md`.

## 0. İlkeler

- **Sırlar environment düzeyine konur, repo düzeyine değil.** Workflow
  `phase-one-acceptance` environment'ını kullanır; deploy workflow'u
  `staging`/`production` environment'larını kullanır. Onay korumaları da
  environment üzerinden tanımlanır.
- **Her kimlik en-dar yetkiyle açılır.** IAM ayrım testleri (T-06, K-4) tam da
  bu darlığı kanıtlar; geniş bir anahtar verilirse test FAIL üretir, bu bir
  koşu hatası değil gerçek bulgudur.
- **Kabul yalnız sentetik veriyle koşar.** Workflow `ACCEPTANCE_SYNTHETIC_ONLY`
  ve `ACCEPTANCE_PRODUCTION_GUARD` değerlerini sabitler; bu runbook'taki hiçbir
  kaynak üretim verisi içeremez.
- Aşağıdaki `gh` komutları depo kökünden, `gh auth login` sonrası çalıştırılır.
  `--env` bayrağı environment sırrı/değişkeni yazar.

## 1. GitHub environment'larını oluştur

GitHub → Settings → Environments altında üç environment açılır:

| Environment | Kullanan workflow | Koruma önerisi |
|---|---|---|
| `staging` | `deploy.yml` | — |
| `production` | `deploy.yml` | Zorunlu onaylayıcı: Bilgi İşlem |
| `phase-one-acceptance` | `phase-one-acceptance.yml` | Zorunlu onaylayıcı: Bilgi Güvenliği + Arşiv temsilcisi |

> Environment onayı koşuyu **çalıştırma** yetkisidir; release imzası değildir.
> Kurumsal onaylar manifest üretildikten sonra ayrı release kapısında toplanır.

## 2. Faz A — Dağıtım ayağa kalksın (`deploy.yml`)

```bash
gh secret set CLOUDFLARE_API_TOKEN --env staging
gh secret set CLOUDFLARE_ACCOUNT_ID --env staging
gh secret set DEPLOY_BASE_URL --env staging          # ör. https://sivas-dijital-arsiv-staging.<hesap>.workers.dev
gh secret set ARCHIVE_MIGRATION_TOKEN --env staging  # >= 32 karakter rastgele
```

Aynı sırlar `production` environment'ına kendi değerleriyle tekrarlanır.

### 2.1 Cloudflare staging worker sırları

`wrangler.jsonc` staging bloğunun zorunlu saydığı sırlar worker'a girilir:

```bash
wrangler secret put CONTENT_SCAN_SERVICE_URL --env staging
wrangler secret put CONTENT_SCAN_SERVICE_TOKEN --env staging
wrangler secret put DOCUMENT_RENDER_SERVICE_URL --env staging
wrangler secret put DOCUMENT_RENDER_SERVICE_TOKEN --env staging
wrangler secret put DOCUMENT_RENDER_IMAGE_DIGEST --env staging
wrangler secret put OCR_SERVICE_URL --env staging
wrangler secret put OCR_SERVICE_TOKEN --env staging
wrangler secret put ARCHIVE_MIGRATION_TOKEN --env staging
wrangler secret put ARCHIVE_ACCEPTANCE_TOKEN --env staging   # bkz. Faz B — GitHub'dakiyle AYNI değer
wrangler secret put ARCHIVE_ADMIN_EMAILS --env staging
```

> `ARCHIVE_ACCEPTANCE_TOKEN` kanıt ucunun (`/api/admin/acceptance-evidence/*`)
> anahtarıdır: yalnız `APP_ENV=staging`'de çalışır, üretimde uç 404 döner.
> GitHub tarafındaki değerle bire bir aynı olmalıdır; değilse bütün
> kanıt-zinciri doğrulamaları `*_EVIDENCE_UNAVAILABLE` / `*_TOKEN_MISSING`
> kodlarıyla FAIL verir.

## 3. Faz B — Kabul çekirdeği (`staging` yeteneği)

Bunlar tamamlandığında K-1, K-2, K-3, K-7, T-02, T-03, T-05, T-12 koşabilir.

```bash
gh secret set ACCEPTANCE_BASE_URL --env phase-one-acceptance          # staging HTTPS adresi
gh secret set ARCHIVE_MIGRATION_TOKEN --env phase-one-acceptance      # Faz A'dakiyle aynı
gh secret set ARCHIVE_ACCEPTANCE_TOKEN --env phase-one-acceptance     # Faz A'dakiyle aynı, >= 32 karakter
gh secret set ACCEPTANCE_UPLOADER_IDENTITY --env phase-one-acceptance # ör. kabul-yukleyici@sivas.bel.tr
# Yalnız kurum içi SSO vekilli staging: vekilin sentetik kimlik geçidi jetonu
# (deploy/kurum-ici/sso/README.md; .env ACCEPTANCE_PROXY_TOKEN ile AYNI değer)
gh secret set ACCEPTANCE_PROXY_TOKEN --env phase-one-acceptance

gh variable set ACCEPTANCE_UPLOADER_UNIT --env phase-one-acceptance --body "Kabul Testleri"
gh variable set ACCEPTANCE_SCHEMA_VERSION --env phase-one-acceptance --body "<sema-surumu>"
gh variable set ACCEPTANCE_ADAPTER_PROFILE --env phase-one-acceptance --body "r2-standard"
```

### 3.1 Kapı girdileri (manifest çıkış ölçütleri)

Bu dört değişken olmadan teknik kapı hiçbir koşuda açılmaz:

```bash
gh variable set ACCEPTANCE_PHASE_ZERO_RESULT --env phase-one-acceptance --body "PASS"
gh variable set ACCEPTANCE_PHASE_ZERO_EVIDENCE_DIGEST --env phase-one-acceptance --body "<faz0-kanit-sha256>"
gh variable set ACCEPTANCE_OPEN_CRITICAL_FINDINGS --env phase-one-acceptance --body "0"
gh variable set ACCEPTANCE_OPEN_HIGH_FINDINGS --env phase-one-acceptance --body "0"
```

> Bu değerler beyandır ama manifestte değişmez kanıt olarak saklanır; yanlış
> beyan denetimde görünür. Faz 0 özeti gerçek kanıt paketinin SHA-256'sıdır.

### 3.2 Yükleyici kimliğinin yetkilendirilmesi

Sentetik yükleyici staging kullanıcı tablosunda (`archive_users`) şu profille
bulunmalıdır:

- rol: `archive_manager` (document.upload + document.read + document.download)
- müdürlük: `ACCEPTANCE_UPLOADER_UNIT` ile aynı değer
- aktif: 1

K-7'nin belge listesi doğrulaması `document.read`, T-02'nin kasa indirme
zinciri `document.download` gerektirir; `viewer`/`reviewer` rolü yetmez.

## 4. Faz C — Birincil S3 (`s3` yeteneği → T-01, T-08, T-12 depo fazı, K-5 ön koşulu)

```bash
gh secret set ACCEPTANCE_S3_ENDPOINT --env phase-one-acceptance        # https://<hesap>.r2.cloudflarestorage.com
gh secret set ACCEPTANCE_ORIGINAL_BUCKET --env phase-one-acceptance
gh secret set ACCEPTANCE_QUARANTINE_BUCKET --env phase-one-acceptance  # asıl kovadan FARKLI olmalı
gh secret set ACCEPTANCE_S3_ACCESS_KEY_ID --env phase-one-acceptance
gh secret set ACCEPTANCE_S3_SECRET_ACCESS_KEY --env phase-one-acceptance
gh secret set ACCEPTANCE_S3_SESSION_TOKEN --env phase-one-acceptance   # yalnız STS kullanılıyorsa
gh variable set ACCEPTANCE_S3_REGION --env phase-one-acceptance --body "auto"
```

Birincil kimliğin kapsamı: asıl + karantina kovalarında okuma; T-01 koşullu
yazma probu için asıl kovada `acceptance/immutability/*` önekine yazma. T-09
kullanılacaksa geri yükleme kovasına da yazabilmelidir (Faz F).

## 5. Faz D — IAM ayrım kimlikleri (`iamIdentities` → T-04, T-05, T-06, K-4)

Uygulama içi iki test kullanıcısı:

```bash
gh secret set ACCEPTANCE_VIEWER_IDENTITY --env phase-one-acceptance        # rol: viewer (yalnız document.read)
gh secret set ACCEPTANCE_UNAUTHORIZED_IDENTITY --env phase-one-acceptance  # arşiv kullanıcısı OLMAYAN ya da kapsam dışı kimlik
```

Dört ayrı S3 rol kimliği (her rol için üçlü; SESSION_TOKEN yalnız STS'te):

```bash
for ROLE in VIEWER APPLICATION SCANNER OCR; do
  gh secret set ACCEPTANCE_${ROLE}_S3_ACCESS_KEY_ID --env phase-one-acceptance
  gh secret set ACCEPTANCE_${ROLE}_S3_SECRET_ACCESS_KEY --env phase-one-acceptance
  gh secret set ACCEPTANCE_${ROLE}_S3_SESSION_TOKEN --env phase-one-acceptance
done
```

Beklenen kapsamlar (testler tam bu matrisi kanıtlar):

| Rol | Asıl kova | Karantina kovası |
|---|---|---|
| VIEWER | erişim yok | erişim yok |
| APPLICATION | erişim yok (yalnız bilet servisi) | erişim yok |
| SCANNER | erişim yok | yalnız okuma |
| OCR | yalnız okuma | erişim yok |

## 6. Faz E — Değişmezlik kilidi (`providerLockProfile` → T-07)

```bash
gh variable set ACCEPTANCE_LOCK_PROFILE --env phase-one-acceptance --body "r2-bucket-lock-pilot-v1"
gh secret set ACCEPTANCE_LOCK_BUCKET --env phase-one-acceptance
gh secret set ACCEPTANCE_LOCKED_PREFIX --env phase-one-acceptance
gh secret set ACCEPTANCE_UNLOCKED_PREFIX --env phase-one-acceptance
gh secret set ACCEPTANCE_LOCK_PROBE_S3_ACCESS_KEY_ID --env phase-one-acceptance
gh secret set ACCEPTANCE_LOCK_PROBE_S3_SECRET_ACCESS_KEY --env phase-one-acceptance
gh secret set ACCEPTANCE_LOCK_PROBE_S3_SESSION_TOKEN --env phase-one-acceptance
gh secret set ACCEPTANCE_RETENTION_ADMIN_S3_ACCESS_KEY_ID --env phase-one-acceptance
gh secret set ACCEPTANCE_RETENTION_ADMIN_S3_SECRET_ACCESS_KEY --env phase-one-acceptance
gh secret set ACCEPTANCE_RETENTION_ADMIN_S3_SESSION_TOKEN --env phase-one-acceptance
```

Kilit kovasında sürümleme + Object Lock (ya da R2 bucket-lock pilotu) açık
olmalı; `LOCKED_PREFIX` altındaki nesneler mutasyona kapalı, `UNLOCKED_PREFIX`
kontrol önekidir.

## 7. Faz F — Yedek ve taşınabilirlik (`restoreDrill` → T-09, `secondProvider` → T-10)

```bash
# T-09: izole geri yükleme kovası (asıl kovadan farklı; birincil kimlik yazabilmeli)
gh secret set ACCEPTANCE_RESTORE_BUCKET --env phase-one-acceptance
gh variable set ACCEPTANCE_RESTORE_RTO_SECONDS --env phase-one-acceptance --body "900"   # isteğe bağlı, varsayılan 900
gh secret set ACCEPTANCE_DERIVATIVE_BUCKET --env phase-one-acceptance                    # isteğe bağlı: türevler de tatbikata girecekse

# T-10: ikinci S3 uyumlu sağlayıcı (birinciden FARKLI uç) ve bağımsız kimlik
gh secret set ACCEPTANCE_SECOND_S3_ENDPOINT --env phase-one-acceptance
gh secret set ACCEPTANCE_SECOND_BUCKET --env phase-one-acceptance
gh secret set ACCEPTANCE_SECOND_S3_ACCESS_KEY_ID --env phase-one-acceptance
gh secret set ACCEPTANCE_SECOND_S3_SECRET_ACCESS_KEY --env phase-one-acceptance
gh secret set ACCEPTANCE_SECOND_S3_SESSION_TOKEN --env phase-one-acceptance
gh variable set ACCEPTANCE_SECOND_S3_REGION --env phase-one-acceptance --body "auto"
```

İkinci sağlayıcı gerçekten farklı bir adaptör olmalıdır (ör. MinIO ya da başka
hesapta R2); T-10 bütünlük kararının ETag'e değil içerik SHA-256'sına
dayandığını bu heterojenlikle kanıtlar.

## 8. Faz G — Log/metrik ve anahtarlı testler (T-11, K-5, K-6)

```bash
# T-11: erişim/anahtar loglarında kişisel veri taraması
gh secret set ACCEPTANCE_LOG_ENDPOINT --env phase-one-acceptance   # HTTPS log okuma ucu
gh secret set ACCEPTANCE_LOG_TOKEN --env phase-one-acceptance      # >= 32 karakter

# K-6: kaynak/bellek metrik kanıtı ve büyük test verisi anahtarı
gh secret set ACCEPTANCE_RESOURCE_METRICS_ENDPOINT --env phase-one-acceptance
gh secret set ACCEPTANCE_RESOURCE_METRICS_TOKEN --env phase-one-acceptance
gh variable set ACCEPTANCE_LARGE_FIXTURES --env phase-one-acceptance --body "enabled"

# K-5: hata enjeksiyonu anahtarı (yalnız üretim-dışı ortam güvencesiyle)
gh variable set ACCEPTANCE_FAULT_INJECTION --env phase-one-acceptance --body "enabled"
```

> `ACCEPTANCE_EXECUTOR_MODULE` değişkenini tanımlamak GEREKMEZ: boş
> bırakıldığında workflow repodaki `scripts/acceptance-executors/pipeline.mjs`
> varsayılanını kullanır. Farklı bir değer yalnız bilinçli bir kısıtlama için
> verilmelidir; modül her durumda `scripts/acceptance-executors/` dışından
> yüklenemez.

## 9. Koşuyu çalıştırma ve doğrulama

1. `deploy.yml` ile staging dağıtımını yap ve doğrulama adımının geçtiğini gör.
2. `phase-one-acceptance.yml` workflow'unu elle tetikle; environment onayını ver.
3. Koşu çıktısındaki `acceptance.run-complete` olayında:
   - `blocked` listesi, henüz kurulmamış fazların testlerini göstermelidir —
     başka bir test BLOCKED ise yetenek girdilerinden biri eksik/bozuktur;
   - `technicalGate.passed` yalnız bütün testler PASS + kanıt sözleşmesi
     sağlandığında `true` olur.
4. Manifest ve kanıt paketi `outputs/acceptance/<runId>/` altında üretilir;
   `manifest.json.sha256` özeti değişmez arşive (yedek kataloğu) kaydedilir.
5. Kurumsal onaylar (`ACCEPTANCE_APPROVALS_JSON` release kapısı) teknik
   manifest özetine bağlanarak ayrı adımda toplanır.

## 10. Sık karşılaşılan hata kodları

| Kod | Anlamı | Muhtemel eksik |
|---|---|---|
| `EXECUTOR_NOT_CONFIGURED` | Test için yürütücü yok | Yalnız `ACCEPTANCE_EXECUTOR_MODULE` bilinçli daraltıldıysa görülür |
| `CAPABILITY_MISSING` (BLOCKED) | Yetenek girdileri eksik | İlgili fazın sır/değişkenleri |
| `*_ACCEPTANCE_TOKEN_MISSING` / `*_EVIDENCE_UNAVAILABLE` | Kanıt ucuna erişilemiyor | `ARCHIVE_ACCEPTANCE_TOKEN` (iki tarafta aynı değer) ya da staging `APP_ENV` |
| `K7_DOCUMENT_LIST_UNAVAILABLE`, `T02_TICKET_DENIED` | Yükleyici kimliğinin rolü dar | §3.2 rol/müdürlük ataması |
| `T06_*`, `K4_*` erişim FAIL'leri | IAM anahtarı beklenenden geniş/dar | §5 kapsam matrisi |
| `T10_SECOND_PROVIDER_UNCONFIGURED` | İkinci adaptör istemcisi kurulamadı | §7 ikinci sağlayıcı sır seti |
| `T09_RTO_EXCEEDED` | Tatbikat süresi hedefi aştı | Hedefi gözden geçir ya da ortam performansını incele |
