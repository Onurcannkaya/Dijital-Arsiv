# Karar Dosyası — Üretim Yerleşimi ve İş Etki Analizi Kararları

> **DURUM (2026-08-12): Yedi karar da teknik önerilerle onaylanıp imzalandı.**
> Kalıcı kayıt: `ADR-018-URETIM-YERLESIMI-KARARLARI.md`. İmzalı nüsha kurum
> arşivindedir; bu dosya tarihsel çalışma belgesi olarak korunur.

Amaç: `S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md`'nin "üretim öncesinde kurum
sahiplerince onaylanacak kararlar" listesindeki YEDİ kararı tek toplantıda
sonuçlandırmak. Her karar için bağlam, seçenekler ve teknik öneri hazırdır;
boş bırakılan **KARAR** alanları toplantıda doldurulur. Kararlar verildiğinde
sondaki "yapılandırmaya işlenecek değerler" listesi geliştirmeye geri döner.

Teknik zemin: Faz 1 kabul hattı ve 19 canlı kabul testi ana daldadır; kurum
içi çalışma zamanı (Node + SQLite + MinIO) portu tamamlanmış ve 320 birim
testiyle doğrulanmıştır (`YOL_HARITASI_FAZLAR.md` §13). Bu dosya karar
verilmeden hiçbir üretim kurulumuna başlanmaz.

---

## Karar 1 — Üretim S3 sağlayıcısı ve kurum içi/bulut yerleşimi

**Bağlam.** Pilot Cloudflare (Workers+D1+R2) üzerinde geliştirildi; tasarım
belgesi bunu açıkça "dikey pilot" sayar. Belediye verisinin yerleşimi KVKK ve
kurumsal politika konusudur.

**Seçenekler.**
- **A) Kurum içi: MinIO + Node yığını (ÖNERİLEN).** Veri kurum sınırında;
  `arsiv-asil` kovası MinIO Object Lock ile gerçek WORM (ADR-016 iyileşmesi);
  port hazır ve testli. Maliyet: sunucu + işletim sorumluluğu kurumda.
- **B) Cloudflare'de kalmak.** İşletim yükü düşük; ancak veri yurt dışı
  bulutta, R2 kilidi mevzuatsal WORM sayılmaz, üretim hedef mimarisiyle
  çelişir.
- **C) Hibrit (kurum içi asıl + bulut yedek).** İkinci hata alanı sorusuna
  bulut cevabı verir; KVKK değerlendirmesi yedek kopya için de gerekir.

**Öneri.** A; pilot Cloudflare ortamı yalnız sentetik veriyle CI/deneme
amaçlı tutulabilir ya da tamamen kapatılır.

**KARAR:** ______________________  **Tarih:** ________  **İmza (Bilgi İşlem):** ________

## Karar 2 — KMS/anahtar sahipliği ve dönüşüm süresi

**Bağlam.** Pilotta şifreleme "provider-managed" idi. Kurum içinde disk ve
nesne şifrelemesinin anahtar sahipliği tanımlanmalı.

**Öneri.** 1. dalga: sunucu disklerinde LUKS + MinIO erişim denetimi; 2.
dalga: MinIO KES ile SSE ve kurum sahipliğinde anahtar (yıllık dönüşüm).
Anahtar yedeği çevrimdışı kasada, iki ayrı yetkilide.

**KARAR (yöntem/sahip/dönüşüm):** ______________________  **İmza (Bilgi Güvenliği):** ________

## Karar 3 — Nihai RPO/RTO, kapasite ve büyüme hedefi

**Bağlam.** ADR-017 pilot hedefleri: üst veri RPO 15 dk / RTO 4 sa; kabul
edilmiş asıllar RPO 1 sa / RTO 8 sa; türevler 24 sa (yeniden üretilebilir).
T-09 tatbikatı bu hedefe karşı ölçüm yapar (`ACCEPTANCE_RESTORE_RTO_SECONDS`).

**Karar gerektirenler.**
- Pilot tablosu üretim hedefi olarak onaylanıyor mu, sıkılaştırılıyor mu?
  (Sessizce gevşetme ADR gereği yasak.)
- Kapasite: yıllık beklenen belge adedi/hacmi ve 5 yıllık büyüme tahmini
  (disk planlaması + K-6 eşzamanlılık profili buna bağlanır).

**Öneri.** Pilot tablosunu üretim hedefi olarak onaylamak; hacim tahminini
Yazı İşleri + Arşiv'den almak.

**KARAR (RPO/RTO tablosu + yıllık hacim):** ______________________  **İmza (Bilgi İşlem + Arşiv):** ________

## Karar 4 — İkinci hata alanı ve çevrimdışı yedek hedefi

**Bağlam.** Asıl kovasının artımlı kopyası ayrı bir hata alanına gider
(ADR-017); T-10 taşınabilirlik testi ikinci MinIO'yu bu hedefte koşturur.
Çevrimdışı (soğuk) yedek, fidye yazılımı senaryosunun son savunmasıdır.

**Seçenekler (ikinci alan).** Aynı bina farklı sistem odası / il içinde ayrı
belediye tesisi (ÖNERİLEN) / il dışı kamu veri merkezi.

**Öneri.** İl içi ayrı tesiste ikinci MinIO (site replication); aylık
çevrimdışı manifest+içerik kopyası (harici, salt-okunur saklanan ortam).

**KARAR (tesis + çevrimdışı düzen):** ______________________  **İmza (Bilgi İşlem):** ________

## Karar 5 — Dosya planına bağlı saklama süreleri

**Bağlam.** Asıl/türev/yedek saklama süreleri Devlet Arşivleri mevzuatı ve
kurum dosya planına bağlanmalı; MinIO Object Lock bekletme süresi/modu
(COMPLIANCE) bu karara göre tanımlanır. Tasfiye ancak kurul kararı + dört göz
ilkesiyle olur (ADR-016).

**Öneri.** İlk üretim döneminde tasfiye kapalı (süresiz bekletme); dosya planı
eşlemesi tamamlandığında sınıf bazlı bekletme ADR güncellemesiyle devreye
alınır.

**KARAR (bekletme modu/süreleri):** ______________________  **İmza (Arşiv + Hukuk/KVKK):** ________

## Karar 6 — Bütünlük tarama sıklığı ve hizmet seviyesi eşikleri

**Bağlam.** Tam SHA bütünlük taraması ve iki yönlü uzlaştırma kalıcı bulgu
üretir (T-08/T-12 kanıtlı). Sıklık ve alarm eşikleri işletim kararıdır.

**Öneri.** Uzlaştırma günlük; tam SHA taraması envanterin tamamını 30 günde
bir turlayacak dilimli döngüde; KRİTİK bulguda anında alarm + 1 iş günü
içinde müdahale; açık kritik bulgu varken yeni müdürlük alımı durdurulur.

**KARAR (sıklık + eşikler):** ______________________  **İmza (Bilgi Güvenliği + Depolama İşletimi):** ________

## Karar 7 — Sağlayıcıdan çıkış ve veri imha yetkilileri

**Bağlam.** Taşınabilir paket (F1.10) çıkış yolunu teknik olarak kanıtlıyor
(T-10). Çıkış ve imha PROSEDÜRÜNÜN kimin kararıyla, hangi kurulla
yürütüleceği tanımlanmalı.

**Öneri.** Çıkış/imha kararı: Arşiv + Bilgi İşlem + Hukuk/KVKK'dan oluşan
kurul; uygulama dört göz ilkesiyle ayrı tasfiye kimliği üzerinden; her adım
denetim kaydına bağlanır.

**KARAR (kurul üyeleri):** ______________________  **İmza (Başkanlık/Yetkili Makam):** ________

---

## Karar sonrası: yapılandırmaya işlenecek değerler

Kararlar netleştiğinde geliştirmeye dönecek somut çıktılar:

| Karar | Yapılandırma çıktısı |
|---|---|
| 1 | Üretim `.env` (kanonik host, `APP_ENV=production`); Cloudflare ortamının kaderi |
| 2 | Disk/SSE şifreleme planı; 2. dalga KES işi yol haritasına |
| 3 | `ACCEPTANCE_RESTORE_RTO_SECONDS`; disk kapasite planı; K-6 profil parametreleri |
| 4 | İkinci MinIO ucu (T-10 `ACCEPTANCE_SECOND_S3_ENDPOINT`), replikasyon ve soğuk yedek takvimi |
| 5 | `mc retention` bekletme modu/süresi; tasfiye prosedürü ADR güncellemesi |
| 6 | Tarama zamanlayıcı ayarları ve alarm eşikleri |
| 7 | Tasfiye kimliği ve kurul onay akışı |

## Onay tablosu

| Rol | Ad Soyad | Tarih | İmza |
|---|---|---|---|
| Bilgi İşlem yöneticisi | | | |
| Bilgi Güvenliği sorumlusu | | | |
| Arşiv sorumlusu | | | |
| Hukuk/KVKK temsilcisi | | | |
