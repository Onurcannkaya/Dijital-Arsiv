# Kapanış Notu — Durum ve Kalan İşler (2026-08-28)

Bu not, kabul hattı + kurum içi port çalışmasının bittiği noktayı ve kalan
işleri devralacak kişi için tek sayfada toplar. Ayrıntı belgeleri:
`YOL_HARITASI_FAZLAR.md` §13, `KURUM_ICI_PORT_KAPSAMI.md`,
`KABUL_ORTAM_KURULUMU.md`, `deploy/kurum-ici/AYAGA_KALDIRMA.md`.

## Bugün itibarıyla bitmiş olanlar

- **F1.11 kabul altyapısı**: Katalogdaki 19 testin tamamının canlı
  yürütücüsü repoda; kanıt sözleşmesi, yetkili kanıt ucu ve manifest kapısı
  çalışıyor. Yetenek girdisi eksik testler dürüstçe BLOCKED kalıyor.
- **Kurum içi port P1–P7**: Uygulama API'si Cloudflare'siz, Node üzerinde
  çalışıyor (uçtan uca kabul akışı testli); SQLite + MinIO adaptörleri,
  konteyner yığını, SSO kaplaması, ayağa kaldırma runbook'u ve duman testi
  hazır. Workers pilotu davranışsal olarak korunuyor (tam takım her
  commit'te Workers build'iyle doğrulanıyor).
- **GitHub tarafı**: `staging`/`production`/`phase-one-acceptance`
  environment'ları açık; `ARCHIVE_MIGRATION_TOKEN` (3 ortam) ve
  `ARCHIVE_ACCEPTANCE_TOKEN` sırları üretilip yazıldı. CI her push'ta kalite
  kapısı + API/UI imaj derleme, salt-okunur açılış smoke'u ve Compose
  birleştirme doğrulaması koşuyor ve main'in ucunda **yeşildir**
  (536/536 test, 2026-08-27). Kurum içi SHA/SBOM/rollback workflow'u da
  repoda; gerçek runner kanıtı bekliyor.
- **Cloudflare pilot dağıtımı elle tetiklemeye indi** (`deploy.yml`,
  2026-08-28): ADR-018 ile üretim hedefi kurum içine taşındığından
  `staging` ortamında `CLOUDFLARE_ACCOUNT_ID`/`DEPLOY_BASE_URL` yok ve
  main'e her push'ta koşan otomatik dağıtım, ön kontrolde düşüp kalıcı
  kırmızı üretiyordu. Workflow'un kalite → dağıtım → `deploy:verify` →
  koşullu rollback sırası ve atteste edilmiş `deployment-evidence-<run-id>`
  sözleşmesi aynen durur; Faz 0 çıkış kapısı etkilenmez.

## Kalan işler (önerilen sıra)

### 1. Kurumsal karar — ✅ TAMAMLANDI (2026-08-12, ADR-018)
- [x] Üretim yerleşimi onaylandı: kurum içi MinIO + Node; Cloudflare yalnız
      sentetik CI/deneme pilotu olarak kalabilir.
- [x] İş Etki Analizi kararları onaylandı: ADR-017 tablosu üretim hedefi
      (tatbikat RTO'su 28800 sn), il içi ayrı tesiste ikinci MinIO + aylık
      soğuk yedek, ilk dönem tasfiye kapalı, günlük uzlaştırma + 30 günlük
      tam SHA turu, üç birimli çıkış/imha kurulu.
- [ ] Açık girdiler (ADR-018): yıllık belge hacmi/büyüme tahmini (Yazı
      İşleri + Arşiv) ve ikinci tesisin ağ ucu.

### 2. Makine kurulumu (P7 sahada)
- [ ] Docker'lı sunucu tahsisi (`AYAGA_KALDIRMA.md` §0 ön koşulları).
- [ ] `deploy/kurum-ici` yığınının ilk açılışı + 10 adımlık doğrulama
      tablosu + `./smoke.sh` (ACCEPTED terminali görülmeli).
- [ ] İlk açılışta doğrulanacak iki repo-dışı varsayım: nginx SSO şablonu
      sözdizimi ve MinIO sürümünün `If-None-Match` koşullu yazma desteği
      (nihai hakem T-01 probudur).
- [ ] Kapalı ağ ise: kurum imaj kayıt defteri + ClamAV imza aynası
      (`FRESHCLAM_MIRROR`) + OCR model taşıma.
- [ ] systemd kalıcılaştırması ve yedekleme düzeni (SQLite checkpoint
      disiplini + MinIO çoğaltma).

### 3. Kimlik (P5 sahada)
- [ ] Keycloak: kurumsal sunucuya realm içe aktarımı (ya da pilot profil),
      `arsiv-vekil` istemci sırrının üretimi.
- [ ] Active Directory LDAP federasyonu; e-postanın (`mail`) eşlendiğinin
      doğrulanması — uygulamada yetkili anahtar e-postadır.
- [ ] SSO kaplamasıyla vekilin devreye alınması; kimliksiz isteğin girişe
      yönlendiğinin ve `oai-*` sahteciliğinin kapalı olduğunun testi.
- [ ] İlk yöneticiler `ARCHIVE_ADMIN_EMAILS` ile bootstrap; müdürlük
      kullanıcılarına uygulama içinden rol ataması.

### 4. Kabul koşusu (P8 — Faz 1'in kapanış kapısı)
- [ ] `KABUL_ORTAM_KURULUMU.md` fazlarının MinIO'ya çevrilmesi: TLS'li dış
      S3 ucu, `s3-object-lock` kilit profili, geri yükleme kovası ve ikinci
      MinIO örneği (T-10). T-11/K-6 için staging'e özel kimlik doğrulamalı
      log/metrik kanıt ucu artık uygulamada hazırdır.
- [ ] Dar IAM kimlikleri: uygulama/scanner/ocr/viewer rol politikaları
      (compose'un tek `readwrite` kullanıcısı kabul için YETMEZ; K-4/T-06
      bu ayrımı fiilen doğrular).
- [ ] `ACCEPTANCE_PROXY_TOKEN` dahil kabul sırlarının
      `phase-one-acceptance` environment'ına girilmesi; environment
      onaycılarının atanması. (`ACCEPTANCE_SCHEMA_VERSION` bu listede
      DEĞİLDİR: elle tutulan değişken 2026-08-28'de silindi, sürüm koşuda
      canlı staging ön kontrolünden gelir.)
- [ ] Koşunun tetiklenmesi → BLOCKED listesi boşalana ve teknik kapı
      açılana kadar iterasyon; manifest özetinin değişmez arşive alınması.
- [ ] Kurumsal release onayları (Bilgi İşlem + Bilgi Güvenliği + Arşiv;
      T-07 N/A ise Hukuk/KVKK) — manifest özetine bağlanır.

### 5. Sonraki dalgalar (Faz 1 sonrası, ayrı planlama)
- [x] UI'nin kurum içi sunumu (sırsız ayrı UI konteyneri + SSO vekili).
- [ ] P9: PostgreSQL geçişi + arama iyileştirmesi (çok replika gerekirse
      öne çekilir) + MinIO KES/SSE ile kurum sahipliğinde anahtar (ADR-018
      Karar 2, 2. dalga).
- [ ] EBYS / kent bilgi sistemi (ada-parsel) entegrasyonları — varlık
      modeli hazır, bağlantılar ayrı analiz ister.
- [ ] Kabul sonrası hijyen: `ACCEPTANCE_PROXY_TOKEN` rotasyonu, kabul
      artefaktlarının temizliği, `APP_ENV=production` geçişinde kanıt
      ucunun kapandığının doğrulanması.

## Kırmızı çizgiler (devralana hatırlatma)

- Teknik kapı açılmadan Faz 1 "bitti" ilan edilmez; müdürlük toplu geçişi
  yapılmaz (`YOL_HARITASI_FAZLAR.md` §12).
- Kabul yalnız sentetik veriyle koşar; üretim verisi hiçbir kabul/deneme
  akışına girmez.
- Fail-closed davranışlar (boş jetonla açılmayan vekil, eski imzayla duran
  tarayıcı, eksik env ile açılmayan API) arıza değil tasarımdır; geçici
  çözümle esnetilmez, kök neden giderilir.
