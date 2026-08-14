# Kabul Koşusu Hazırlık Durumu — 2026-08-14

Bu belge, Faz 1 kabul koşusu (`KABUL_ORTAM_KURULUMU.md`) öncesinde **kod
tarafının hazır olduğunu kanıtlayan yerel provanın** sonuçlarını ve koşunun
açılması için kurum/işletim tarafında bekleyen girdilerin envanterini tutar.
Koşu tetiklenmeden önce bu envanterdeki her satır kapatılmalı ya da bilinçli
olarak BLOCKED bırakılacağı kabul edilmelidir.

## 1. Yerel prova sonuçları (bu depo, bu makine)

| Prova | Sonuç |
|---|---|
| Tam test takımı (`npm test`) | **430/430 yeşil** (16.7 sn) |
| Şema | v28; taze veritabanında `0 → 28` göçü tek adımda uygulandı |
| Kabul hattı kuru koşusu (`run-phase-one-acceptance.mjs`, yeteneksiz) | Manifest üretildi; 19 testin 19'u **dürüstçe BLOCKED**, teknik kapı gerekçeleriyle kapalı (`EXIT_PHASE_ZERO_NOT_PROVEN`, `EXIT_*_FINDINGS_OPEN`, `BLOCKED:*`) |
| Yürütücü modülü | `scripts/acceptance-executors/pipeline.mjs` repoda; sahte-S3/sahte-staging karşılığındaki yürütücü testleri tam takımda yeşil |

Kuru koşu, boru hattının ve manifest/kanıt sözleşmesinin bu depo sürümüyle
çalıştığını kanıtlar: koşu açıldığında sürpriz, yalnız ortam girdilerinden
gelebilir.

## 2. Koşu öncesi güncellenmesi ZORUNLU değerler

- **`ACCEPTANCE_SCHEMA_VERSION` = `28`** — şema bu hafta 27→28 ilerledi
  (arşivleme tasnifi, PR #47). Eski değerle koşu şema doğrulamasında düşer.
- `ACCEPTANCE_GIT_COMMIT` — koşulan dağıtımın gerçek SHA'sı (workflow verir).
- `DEPLOY_BASE_URL` / `ACCEPTANCE_BASE_URL` — staging worker adresi.

## 3. Ortam girdileri envanteri (KABUL_ORTAM_KURULUMU fazları)

| Faz | Açtığı testler | Girdiler | Sahibi | Durum |
|---|---|---|---|---|
| A — Dağıtım | (ön koşul) | Cloudflare jetonları, staging worker sırları (OCR/tarama/render servis uçları dahil) | Bilgi İşlem | Bekliyor |
| B — Kabul çekirdeği | K-1, K-2, K-3, K-7, T-02, T-03, T-05, T-12 | `ACCEPTANCE_BASE_URL`, kabul/göç jetonları, sentetik yükleyici (rol: `archive_manager`, müdürlük: "Kabul Testleri") | Bilgi İşlem + Arşiv | Bekliyor |
| B.1 — Kapı beyanları | teknik kapı | Faz 0 sonucu + kanıt SHA-256'sı, açık kritik/yüksek bulgu sayıları | Bilgi Güvenliği | Bekliyor |
| C — Birincil S3 | T-01, T-08, K-5 ön koşulu | R2/S3 uç + kova + dar kimlik | Bilgi İşlem | Bekliyor |
| D — IAM ayrımı | T-04, T-05, T-06, K-4 | 2 uygulama kimliği + 4 rol için S3 üçlüleri (kapsam matrisi runbook §5) | Bilgi İşlem | Bekliyor |
| E — Değişmezlik kilidi | T-07 | Object Lock/bucket-lock pilotu kovası + prob kimlikleri | Bilgi İşlem | Bekliyor |
| F — Yedek/taşınabilirlik | T-09, T-10 | Geri yükleme kovası (RTO 8 saat, ADR-018) + ikinci sağlayıcı (gerçekten farklı adaptör) | Bilgi İşlem | Bekliyor |
| G — Log/metrik/anahtar | T-11, K-5, K-6 | Log ve metrik uçları + jetonları, büyük veri/hata enjeksiyonu anahtarları | Bilgi İşlem | Bekliyor |

Fazlar kademelidir: yalnız A+B kurulunca 8 test koşar, kalanı BLOCKED kalır
ve bu bir hata değildir — koşu eksikliği dürüstçe raporlar.

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
