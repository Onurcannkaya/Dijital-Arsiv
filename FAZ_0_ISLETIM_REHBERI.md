# Faz 0 — Teslim ve İşletim Rehberi

Bu belge, uygulamanın geliştirme ortamından çalışan bir teslim ortamına güvenli
biçimde çıkarılması için uygulanabilir sözleşmedir. Müdürlük profilleri bu fazın
dışındadır; önce ortak omurga ayağa kaldırılır.

## Ortamlar ve bağlar

`wrangler.jsonc` geliştirme, staging ve production adlarını; cron tetikleyicilerini,
gözlemlenebilirliği ve zorunlu sır adlarını tanımlar. D1 ve R2'nin mantıksal bağları
`.openai/hosting.json` içindeki `DB` ve `ARCHIVE_FILES` adlarıdır. Gerçek kaynak
kimlikleri Sites kontrol düzleminde tutulur; repoya sahte kimlik veya sır yazılmaz.

Zorunlu çalışma zamanı değerleri:

| Anahtar | Gizli | Amaç |
|---|---:|---|
| `OCR_SERVICE_URL` | Hayır | Worker'ın erişebildiği TLS'li OCR servis adresi |
| `OCR_SERVICE_TOKEN` | Evet | Uygulama–OCR servis kimlik doğrulaması |
| `ARCHIVE_MIGRATION_TOKEN` | Evet | Yalnız şema göç uç noktası |
| `ARCHIVE_ADMIN_EMAILS` | Evet | İlk yönetici allow-list'i |

Doğrudan Wrangler ile yönetilen bağımsız Worker kurulumunda sırlar her ortam için
`npx wrangler secret put ANAHTAR --env staging` biçiminde girilir. Sites ile
yayımlanan bu projede aynı değerler Sites çalışma zamanı ortamına secret olarak
girilir ve ardından yeni kayıtlı sürüm dağıtılır.

## Teslim kapıları

Her değişiklikte GitHub Actions aşağıdaki kapıları çalıştırır:

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` üretim derlemesini de yapar. `.dev.vars` dosyasının sürüm kontrolüne
girmesi CI tarafından ayrıca reddedilir. Sites paketleyicisi, araç zinciri yerel
bir `.dev.vars` kopyası üretse bile bunu dağıtım arşivinden zorunlu olarak siler.

Dağıtımdan sonra aşağıdaki komut göçü uygular, şema sürümünü tekrar okur ve D1,
nesne deposu, OCR ve şema readiness denetimlerinin tamamını doğrular:

```bash
DEPLOY_BASE_URL=https://staging.example \
ARCHIVE_MIGRATION_TOKEN=... \
npm run deploy:verify
```

Komut sıfır dışında dönerse yeni sürüm trafiğe açık bırakılmaz. Sites yayınında
önceki kayıtlı sürüm tekrar dağıtılır; doğrudan Wrangler yayınında
`npx wrangler rollback --env staging --yes --message "migration gate failed"`
çalıştırılır. Şema göçleri bu nedenle genişlet–taşı–daralt düzeninde ve önceki
uygulama sürümüyle geriye uyumlu yazılır; uygulama geri alma, yıkıcı şema geri alma
anlamına gelmez.

## Zamanlanmış işler

| UTC zamanlaması | İş | Dilim sınırı |
|---|---|---|
| `*/2 * * * *` | OCR kuyruğu tüketimi | En çok 5 iş / 8 dakika |
| `*/5 * * * *` | Arama dizini bakım işi | 3 × 200 kayıt |
| `17 */6 * * *` | Nesne bütünlük taraması | 20 nesne |

OCR hataları 30 saniyeden başlayan üstel geri çekilmeyle en fazla bir saate kadar
ertelenir. Azami deneme sayısını aşan işler dead-letter olarak görünür. Kuyruk
derinliği, retry bekleyenler, dead-letter sayısı ve son 24 saat hata oranı
`/api/overview` yanıtındadır; cron günlükleri aynı değerleri tek satır JSON olarak
yazar.

## OCR barındırma kararı

Faz 0 başlangıç profili CPU'dur. Docker imajı PP-OCR modelini derleme sırasında
indirip imaja gömer, ayrıcalıksız `ocr` kullanıcısıyla çalışır ve model belleğe
alınmadan hazır sayılmaz. Servis kurum içi ağda veya TLS sonlandırmalı özel
konteyner platformunda barındırılır; 8090 portu internete doğrudan açılmaz.

GPU geçişi tahminle yapılmaz. Staging pilotunda kuyruk derinliği sürekli artarsa
veya belge başına P95 OCR süresi kabul edilen hizmet seviyesini aşarsa CUDA uyumlu
ayrı imaj profili doğrulanır. Model ve Paddle/CUDA sürümleri imaj etiketiyle birlikte
sabitlenmeden GPU imajı production'a alınmaz.

## Faz 0 çıkış kanıtı

Faz ancak staging ortamında gerçek bir pilot belgenin kullanıcı tarafından
yüklenmesi, cron tarafından elle uç nokta çağrılmadan OCR'a alınması, doğrulama
kuyruğuna düşmesi ve arşivlenmesiyle tamamlanır. Kanıt paketi en az şu değerleri
içerir: belge kimliği, OCR iş kimliği, model sürümü, korelasyon kimliği, şema
sürümü, health çıktısı ve denetim olayı numarası.
