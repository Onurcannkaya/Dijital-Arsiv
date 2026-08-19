# Karar Paketi — Bekleyen Kurum Kararları (Ağustos 2026)

Amaç: Yazılım tarafında bekleyen işi kalmamış, **yalnız kurum kararı bekleyen**
dokuz başlığı tek pakette sonuçlandırmak. Her başlık için bağlam, ölçüm ve
teknik öneri hazırdır; boş bırakılan **KARAR** alanları toplantıda doldurulur.
Biçim, 12 Ağustos'ta yedi kararın tamamını tek toplantıda sonuçlandıran
`KARAR_DOSYASI_URETIM_YERLESIMI.md` dosyasıyla aynıdır.

Teknik zemin (19 Ağustos 2026): 468 birim/uçtan uca test yeşil; hızlı kabul
sihirbazı, ADR-013 operatör kurtarma yolu, ADR-017 yedekleme dilimleri, alarm
taşıyıcısı ve dead-letter yönetimi ana dalda. Buradaki hiçbir başlık kod
eksikliği değildir — kod ya hazırdır ya da karar verilmeden yazılmaması
kurumsal kuraldır.

## Özet tablo

| # | Karar | Sahibi | Kod tarafı | Verilmezse ne olur |
|---|---|---|---|---|
| 1 | 32 GB RAM + eşzamanlı OCR | Bilgi İşlem | Ölçüldü, testli, **kapalı bekliyor** | 6.603 sayfalık yük 74,7 saat sürer (18,7 yerine) |
| 2 | Cilt bölme yaklaşımı (ADR-019) | Arşiv + Yazı İşleri + Hukuk | TASLAK ADR, 4 seçenek | 1.632 kararlı ciltte 1.631 kararın tarihi düşmeye devam eder |
| 3 | Meclis belge profilleri | Yazı İşleri + Arşiv + KVKK | Öneri taslağı hazır | 515 sayfa meclis cildi arşivlenemez durumda bekler |
| 4 | Mahalle/adres sözlüğü kaynağı | İmar/CBS + Bilgi İşlem | Sözlük yuvası hazır, bilinçli boş | OCR mahalleyi öneremez; her belgede elle girilir |
| 5 | Onaylı Standart Dosya Planı | Arşiv + Hukuk | TASLAK tohumlarla çalışıyor | Üretim kapısı açılamaz (WORM'a tasnifsiz kayıt giremez) |
| 6 | ADR-013/014/015/016 kurumsal onayı | Bilgi İşlem + Bilgi Güvenliği + Arşiv (+Hukuk) | Dördü uygulanmış, imza bekliyor | Uygulanan davranışın kurumsal dayanağı eksik kalır |
| 7 | Kabul koşusu (P8) girdileri | Bilgi İşlem + Bilgi Güvenliği | 19 test hazır, 19'u BLOCKED | Faz 1 kapanamaz; üretim tarihi kayar |
| 8 | Yedek hedefi + alarm kanalı | Bilgi İşlem + Bilgi Güvenliği | Kod ana dalda, hedef bekliyor | Yedek dilimleri "yapılandırılmadı"da kalır; alarmlar yalnız log'a düşer |
| 9 | 1975 cildinin kalan okuması | Arşiv (işletim) | Dilim mekanizması kanıtlı | 555 sayfa okunmamış kalır |

---

## Karar 1 — 32 GB RAM ve eşzamanlı OCR dağıtımı

**Bağlam.** OCR hız sorusu ölçümle kapandı (`ARSIV_TARAMA_TEST_RAPORU.md`
§11-12): sekiz motor ayarı denendi, sekizi de veri kaybettirdi ya da
yavaşlattı. ~40 sn/sayfa bu motorun bu sınıf CPU'daki maliyetidir. Kalan tek
kazanç sayfaların **aynı anda** işlenmesidir ve tek kısıt bellektir.

**Ölçüm.** İşçi başına 4.841 MB yerleşik bellek; 4 işçi + işletim sistemi ≈
25 GB. Bugünkü makinede boş RAM 0,31 GB'a düşünce sistem takasa girdi ve sayfa
süresi 40,7 sn'den 156 sn'ye çıktı — belleğin son yüz megabaytı tükendiğinde
kazanç kayba dönüyor. Eşzamanlı iş dağıtımının veri güvenliği ölçüldü
(6 eşzamanlı tetikleme, kayıp yok) ve testle sabitlendi; **bilinçli olarak
kapalı**, çünkü bugünkü makinede açmak zarar veriyor.

**İstenen.** OCR makinesinin **32 GB RAM**'e çıkarılması (en az 8 fiziksel
çekirdek). Donanım gelince eşzamanlı dağıtım küçük bir kod değişikliğiyle
açılır; 6.603 sayfalık mevcut yük 74,7 saatten ~18,7 saate iner.

**KARAR:** ______________________  **Tarih:** ________  **İmza (Bilgi İşlem):** ________

## Karar 2 — Toplu tarama ciltlerinin karar bazında bölünmesi (ADR-019)

**Bağlam.** Bugün bir yükleme = bir belge. Arşivdeki ciltler ise yüzlerce
bağımsız karar taşıyor (ör. "2019 1 - 1632 Encümen Suret": 1.646 sayfa,
~1.632 karar). Tek değerli alanlar (tarih, tür, müdürlük) belge başına
seçildiğinden **1.632 kararlı ciltte tek tarih kalır, 1.631 kararın tarihi
düşer** — hata vermeyen ama yanlış veri üreten yol. Dosya planı ve saklama
süresi de karar başına uygulanamaz.

**Neden otomatik bölme önerilmiyor.** Sınır tespiti güvenilir değil ve hata
iki yönlü ölçüldü (1983 cildinde 1.640 sayfada 131 başlık bulunabildi; 2021
meclis cildinde 30 karara karşı 61 başlık bulundu). Bu yüzden bölme her
aşamada **öneri** olarak kalmalı, memur onaylamadan hiçbir karar kaydı
arşive girmemelidir.

**Seçenekler (ADR-019).** A) Karar dizini (üst veri; aranabilirlik), B) karar
kaydı modeli (saklama/tasnif karar başına), C) yalnız görüntüleme bölmesi,
D) tarama talimatını "karar başına dosya"ya çevirmek (kod istemez).

**Öneri.** **D hemen + A ilk aşama; B, doğruluk kapısı geçilirse** (insan
onaylı ≥200 karar örneğinde kesinlik ≥ %99, anma ≥ %95 ölçülmeden hiçbir cilt
otomatik bölünmez).

**KARAR (yaklaşım/aşama):** ______________________  **İmza (Arşiv):** ________  **İmza (Yazı İşleri):** ________  **İmza (Hukuk):** ________

## Karar 3 — Meclis belge türü profilleri

**Bağlam.** Yürürlükteki altı profil arasında meclis belgesi yok; arşivde iki
meclis cildi (337 + 178 = **515 sayfa**) hattın sonuna kadar gelip orada
duruyor: profil olmadığından tür alanı boş kalıyor, boş tür `CRITICAL` risk
üretiyor ve belge arşivlenemiyor. 2021 cildi tek başına üç ayrı belge türü
taşıyor (gündem, tutanak, karar).

**Hazır olan.** `MECLIS_PROFIL_ONERISI.md` (sürüm 0.1): gerçek ciltler
üzerinde ölçülmüş dört profil önerisi, tespit işaretleri ve alan kümeleri.
Koda hiçbir şey tohumlanmadı — sınıflandırma kurumun kararıdır.

**İstenen.** Yazı İşleri ve arşiv biriminin öneriyi gözden geçirip profil
adlarını/alan kümelerini onaylaması (KVKK açısından tutanaklardaki kişisel
veri değerlendirmesiyle birlikte). Onay gelince profiller sözlük yönetiminden
işlenir ve 515 sayfa hattan geçer.

**KARAR (profiller/değişiklikler):** ______________________  **İmza (Yazı İşleri):** ________  **İmza (Arşiv):** ________

## Karar 4 — Mahalle/adres sözlüğünün yetkili kaynağı

**Bağlam.** Mahalle sözlüğü koda bilinçli olarak boş bırakıldı
(`lib/archive-seed.ts`): sistem kendi mahalle listesini uydurmaz. Sözlük
boşken OCR mahalle öneremiyor ve personel her belgede elle giriyor; 1975
cildi denemelerinde OCR'ın bozuk mahalle okumaları ("Slibaba", "Lzilirmak")
sözlük eşleşmesi olmadığı için süzülemedi.

**İstenen.** Yetkili adres/CBS kaynağının belirlenmesi (hangi sistem, hangi
dışa aktarım), listenin bir kez yüklenmesi ve güncelleme sorumlusunun
atanması. Kod tarafı hazır: sözlük yüklendiği anda OCR eşleşmesi ve süzme
devreye girer.

**KARAR (kaynak/sorumlu):** ______________________  **İmza (İmar-CBS):** ________  **İmza (Bilgi İşlem):** ________

## Karar 5 — Onaylı Standart Dosya Planı ve saklama kuralları

**Bağlam.** `FILE_PLAN` ve `RETENTION_RULE` sözlükleri TASLAK tohumlarla
çalışıyor. Arşivleme tasnif zorunlu (dosya planı + saklama kuralı seçilmeden
belge WORM kasaya giremez) ve arşivlenmiş kayıt değiştirilemez (ADR-016) —
yani yanlış taslakla arşivlenen tasnif kalıcıdır. Kabul koşusunu engellemez
(sentetik veri), **üretim kapısını engeller**.

**İstenen.** Kurumun onaylı Standart Dosya Planı ve saklama planının
ayarlardaki sözlük yönetiminden işlenmesi; TASLAK etiketlerinin kaldırılması.

**KARAR (plan kaynağı/tarih):** ______________________  **İmza (Arşiv):** ________  **İmza (Hukuk):** ________

## Karar 6 — ADR-013/014/015/016 kurumsal onayları

**Bağlam.** Dört mimari karar uygulanmış ve testle sabitlenmiş durumda ama
"kurumsal onay bekliyor" etiketi taşıyor: **ADR-013** kabul durum makinesi
(FAILED oturumun operatör kurtarması dahil — arayüzü bu ay yayında),
**ADR-014** karantina ve zararlı içerik politikası, **ADR-015** PDF erişim
türevi, **ADR-016** asıl nesne değişmezliği (WORM). Uygulama ile kurumsal
dayanak arasındaki bu boşluk denetimde soru üretir.

**İstenen.** Dördünün tek imza turunda onaylanması (ADR-016 için saklama ve
hukuk onayı dahil).

**KARAR:** ______________________  **İmza (Bilgi İşlem):** ________  **İmza (Bilgi Güvenliği):** ________  **İmza (Arşiv):** ________

## Karar 7 — Faz 1 kabul koşusu (P8) girdileri

**Bağlam.** 19 canlı kabul testi hazır; sırsız kuru koşu 19/19'u dürüst
BLOCKED olarak raporladı. Yerleşim kararı gereği koşu **kurum içi staging**
yığınına (Docker: MinIO + ClamAV + render) karşı yapılacak. Tek gerçek dış
bağımlılık bir sunucudur.

**İstenenler.**
1. **Docker'lı staging sunucusu tahsisi** (istek özeti
   `KABUL_HAZIRLIK_DURUMU.md` sonunda) — geliştirme makinesi Docker'sız.
2. **GitHub runner erişim modeli:** DMZ'de erişilebilir staging mi,
   self-hosted runner mı? (Bilgi Güvenliği kararı.)
3. **Log/metrik katmanı (T-11/K-6):** Loki+cAdvisor kurulacak mı, yoksa iki
   test bilinçli BLOCKED mi bırakılacak?
4. **Ortam değerleri:** `ACCEPTANCE_BASE_URL`, sentetik yükleyici kimliği,
   Faz 0 kapı beyanları (sonuç + kanıt özeti, açık kritik/yüksek bulgu
   sayıları), IAM üçlüleri (runbook §5). Ayrıca **`ACCEPTANCE_SCHEMA_VERSION`
   28 → 32** güncellenmeli (şema bu ay v31 OCR iş kirası ve v32 yedek
   defteriyle ilerledi).

**KARAR (sunucu/runner/log kararı):** ______________________  **İmza (Bilgi İşlem):** ________  **İmza (Bilgi Güvenliği):** ________

## Karar 8 — Yedek hedefi ve alarm kanalı

**Bağlam.** ADR-017 yedekleme dilimleri bu hafta koda girdi: saatlik artımlı
asıl kopyası, günlük üst veri dökümü, günlük manifest. Kod, hedef
yapılandırılmadıkça çalışmaz ve pano bunu "Yapılandırılmadı" olarak gösterir.
Alarm taşıyıcısı da hazır: bütünlük bulgusu, OCR dead-letter artışı ve yedek
arızası yapılandırılmış uca JSON iletilir; uç yoksa yalnız log'a düşer.

**İstenenler.**
1. **İkinci hata alanında yedek hedefi:** ayrı makinede/lokasyonda MinIO ucu
   + **üretimden ayrı yönetim kimliği** (ADR-017 şartı; aynı uca aynı
   kimlikle yazmak şartı karşılamaz).
2. **Alarm kanalı:** kurumun hangi ucu dinleyeceği (e-posta geçidi, Teams
   köprüsü, mevcut izleme sistemi) — `ALARM_WEBHOOK_URL` değeri.
3. **15 dk RPO ayağı:** günlük JSON dökümü üst veri RPO'sunun tamamı değildir;
   SQLite anlık görüntü/PITR politikası (AYAGA_KALDIRMA §yedekleme) İş Etki
   Analizine bağlanmalı. ADR-018'in açık girdileri (yıllık belge hacmi ve
   büyüme tahmini, ikinci tesisin ağ ucu) burada birlikte kapatılabilir.

**KARAR (hedef/kanal/politika):** ______________________  **İmza (Bilgi İşlem):** ________  **İmza (Bilgi Güvenliği):** ________

## Karar 9 — 1975 cildinin kalan okuması (işletim)

**Bağlam.** Dilim mekanizması 8 dilimlik kesintisiz koşuda kararlı ölçüldü
(sayaç tüketmiyor, sayfa kaybı yok, süreler 242–280 sn bandında). Cildin
kalanı **555 sayfa ≈ 93 dilim ≈ ~7 saat kesintisiz işlem**. İzlenecek tek
nokta: OCR servisinin belleği dilim başına ~5 MB tırmandı; uzun koşuda eğri
izlenmeli. (Karar 1 alınırsa bu süre de dörde bölünür.)

**İstenen.** Kalan okumanın ne zaman başlatılacağı (mesai dışı gece koşusu
önerilir) ve makinenin o süre boyunca bu işe ayrılması.

**KARAR (başlatma zamanı):** ______________________  **İmza (Arşiv):** ________

---

## Bilgi amaçlı: Kent Rehberi entegrasyonu (bu pakette karar İSTENMİYOR)

Sözleşme taslağı (`KENT_REHBERI_ENTEGRASYON_SOZLESMESI.md`) dört ucu ve veri
modelini tanımlıyor; uygulama tarafında varlık modeli hazır, servis sınırı
bilinçli olarak yazılmadı. Entegrasyon istendiğinde sözleşmedeki **dokuz açık
karar** (kaynak sistem kodu, kimlik aktarımı, ağ topolojisi, koordinat
referans sistemi, kota/SLA, olay sorumlulukları...) ayrı bir turda
kapatılmalıdır.

## Kararlar verildiğinde geliştirmeye dönecek değerler

- Karar 1 → eşzamanlı OCR dağıtım değişikliği açılır (tek PR, testi hazır).
- Karar 2 → ADR-019 seçilen seçenekle KABUL yazılır; A seçildiyse karar
  dizini geliştirmesi planlanır.
- Karar 3 → meclis profilleri sözlük yönetiminden tohumlanır; 515 sayfa
  yeniden tasniften geçirilir.
- Karar 4 → mahalle sözlüğü yüklenir (`vocabulary` yönetimi hazır).
- Karar 5 → `FILE_PLAN`/`RETENTION_RULE` sözlükleri onaylı planla değiştirilir.
- Karar 7 → GitHub ortam değişkenleri girilir (`ACCEPTANCE_SCHEMA_VERSION=32`
  dahil) ve kabul koşusu tetiklenir.
- Karar 8 → `.env` değerleri: `ARCHIVE_S3_BUCKET_BACKUP`,
  `ARCHIVE_BACKUP_S3_ENDPOINT` + ayrı kimlik, `ALARM_WEBHOOK_URL`.
