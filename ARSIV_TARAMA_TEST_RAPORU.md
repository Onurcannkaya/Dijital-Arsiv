# Gerçek Arşiv Tarama Testi — `D:\Arşiv` (14.08.2026)

Kapsam: `D:\Arşiv` altındaki 8 PDF'in ölçülmesi, yerel hattın gerçek sayfalarla
denenmesi ve "hâlâ hata alıyorum" şikâyetinin kök sebebinin bulunması.

## 1. Arşivin gerçek ölçüsü

| Dosya | Sayfa | Boyut | Metin katmanı | 150 dpi sayfa | Gömülü çözünürlük |
|---|---:|---:|---|---:|---:|
| Encümen Asıl / 1975 - 1 - 600 | 623 | 389,2 MB | var, **çöp** | 2,2 MP | ~150 dpi |
| Encümen Asıl / 2021 1 - 75 | 459 | 241,7 MB | var, bozuk | 2,2 MP | ~200 dpi |
| Encümen Asıl / 2021 1580 - 1635 | 397 | 71,1 MB | var, bozuk | 2,2 MP | ~200 dpi |
| Encümen Suret / 1983 | 1640 | 909,3 MB | var, **çöp** | 2,2 MP | ~305 dpi |
| Encümen Suret / 2019 1 - 1632 | 1646 | 303,8 MB | var, bozuk | 2,2 MP | ~200 dpi |
| Encümen Suret / 2020 1 - 1716 | 1749 | 863,4 MB | var, bozuk | 2,2 MP | ~200 dpi |
| Meclis / 1972 | 337 | 221,1 MB | çoğu sayfa **boş** | 1,2–2,1 MP | ~150 dpi |
| Meclis / 2021 1 - 30 | 178 | 83,9 MB | var, **iyi** | 2,2 MP | ~200 dpi |
| **Toplam** | **7.029** | **3,01 GiB** | | | |

Hiçbiri şifreli değil, hiçbiri boyut (2 GiB) veya sayfa (2.000) sınırını aşmıyor.
Sayfa megapikselleri 100 MP sınırının çok altında. Yani **kabul sınırları sorun değil.**

Metin katmanı örnekleri (aynı belge, iki kaynak):

- Gömülü katman (1983): `B•1llut1'1; 26.?.J.91J \uiJll1 _.._ •znleli F•ltleft "Uftrlllllllt•`
- PaddleOCR (aynı sayfa): `Başkanlığın 24.5.1983 tarihli encümen'e havaleli, Muhasebe Müdürlüğünden verilen ayni tarihli yazı okundu:`

Sonuç: gömülü metin katmanı tarihsel evrakta kullanılamaz, **OCR gereklidir ve
kalitesi iyidir** (ölçülen ortalama güven %87–98).

## 2. Kök sebep: OCR 120 saniye tavanı ile ~65 sn/sayfa maliyeti

Servisin kendi ayarlarıyla (`services/ocr/app/main.py` `engine()` birebir) ölçüm,
ısınmış süreçte, Windows CPU:

| Örnek | Sayfa | Süre | Sayfa başı | Satır | Ortalama güven |
|---|---:|---:|---:|---:|---:|
| 1983 Encümen suret | 1 | 54,8 sn | 54,8 sn | 38 | %89,8 |
| 1975 Encümen asıl | 1 | 75,1 sn | 75,1 sn | 101 | %87,2 |
| 2021 Encümen asıl | 1 | 62,2 sn | 62,2 sn | 49 | %98,2 |
| 2021 Meclis | 1 | 52,3 sn | 52,3 sn | 41 | %94,9 |
| 1983, çok sayfalı | 3 | 194,2 sn | 64,7 sn | 182 | %87,1 |

Maliyet sayfa sayısıyla doğrusal: **~65 sn/sayfa.**
`app/api/jobs/process/route.ts:228` OCR isteğine `AbortSignal.timeout(120_000)`
koyuyor. Bu tavan **1,8 sayfaya** karşılık geliyor: pratikte tek sayfadan fazlası
hiç bitmiyor. Karşılaştırma için içerik taraması ve türev üretimi 10 dakika
alıyor (`lib/content-scan.ts:4`, `lib/document-render.ts:17`); tavanı düşük olan
tek adım, zinciri en pahalı adımdır.

Aynı hızla tüm arşiv: 7.029 sayfa × 65 sn ≈ **127 saat** (tek uçuş, tek makine).
Dosya başına: 1983 → 29,6 sa, 2019 → 29,7 sa, 2020 → 31,6 sa, 1975 → 11,2 sa.

### Kullanıcının aldığı hata, veritabanındaki kaydıyla

`processing_jobs` tablosunda, 12:21'de yüklenen 389 MB'lık 1975 dosyası için:

```
document_id: 4c9bc7c6-9aa5-4729-adcd-228b296222e4  (1975 - 1 - 600 Encümen Asıl.pdf)
status: queued   attempt: 1/3
error_message: OCR servisi zaman aşımına uğradı; iş kuyrukta kaldı ve yeniden denenecek.
last_attempt_at: 2026-08-14 12:22:26
```

Yükleme, karantina, tarama ve terfi **başarılı** (oturum `ACCEPTED`, asıl nesne
`ARCHIVE_FILES` içinde, 408.081.441 bayt). Zincir yalnız OCR'da kopuyor.

## 3. Zaman aşımı servisi durdurmuyor — kuyruk zehirleniyor

Bu, tavanın kendisinden daha ağır bir sorun.

Uygulama 120 sn'de vazgeçtiğinde OCR servisi işi bırakmıyor: `run_ocr` senkron
uçtur, çıkarım `_predict_lock` altında sürer ve HTTP isteğinin düşmesi çıkarımı
iptal etmez. Terk edilen 623 sayfalık koşu kilidi **saatlerce** tutar.

Ölçülen kanıt (kullanıcının 11:49'da başlattığı OCR süreci, PID 27576):

- **4.381 saniye CPU** ve artmaya devam ediyor — servis, uygulamanın çoktan
  vazgeçtiği işi hâlâ işliyordu.
- `%TEMP%` içinde aynı dosyanın **4 ayrı 389,2 MB kopyası** (14:33, 14:37, 14:41,
  15:22) — her deneme aslın tamamını diske indiriyor ve `finally` bloğu ancak
  çıkarım dönerse siliyor. **Toplam 1.557 MB sızıntı.**
- Ben **tek sayfalık** bir evrak yüklediğimde (doğrudan ölçümde 62 sn süren aynı
  sayfa) uygulama yine 120,1 sn'de `503` verdi: iş, terk edilmiş koşunun
  arkasında kilidi bekliyordu.
- Servisi yeniden başlattıktan sonra **aynı belge 52,1 saniyede tamamlandı.**

Yani: bir kez toplu dosya denendiğinde, OCR kuyruğu **servis yeniden başlatılana
kadar her belge için** bozuk kalıyor. Kullanıcının "hâlâ hata alıyorum"
gözlemi tam olarak budur.

Üretimde bunun karşılığı: OCR cron'u işi 3 kez dener; her deneme yüzlerce MB'ı
yeniden indirir ve yeni bir çoklu saatlik çıkarım başlatır; tek uçuşlu kilit
yüzünden kurumun tüm OCR kuyruğu durur.

## 4. Bir dosya = yüzlerce ayrı karar (mimari uyuşmazlık)

Metin katmanından tespit edilen karar başlığı sayısı:

| Dosya | Sayfa | Tespit edilen karar başlığı |
|---|---:|---:|
| 2020 1 - 1716 Encümen Suret | 1749 | 1.252 |
| 2019 1 - 1632 Encümen Suret | 1646 | 880 |
| 1975 - 1 - 600 Encümen Asıl | 623 | 487 |
| 1983 Encümen Suret | 1640 | 131 |
| 2021 1 - 75 Encümen Asıl | 459 | 88 |
| 2021 1 - 30 Meclis Kararı | 178 | 61 |

(Eski dosyalarda tespit düşük çıkıyor çünkü gömülü metin katmanı bozuk; gerçek
karar sayısı dosya adındaki aralıklarla uyumlu ve daha yüksek.)

Uygulama modeli ise **1 yükleme = 1 `archive_documents` kaydı** (`lib/ingest-promotion.ts:292`);
sayfa aralığına bölme adımı yok. Sonucu `planFields`
(`app/api/jobs/process/route.ts:55`) belirliyor: tek değerli alanlarda
**en yüksek güvenli tek aday** kazanıyor. 1.632 kararlı bir dosyada belge tarihi,
belge türü ve müdürlük için tek bir değer seçilir; geri kalan 1.631 kararın
değerleri sessizce düşer. Bu, hata vermeyen ama **yanlış veri üreten** yol —
zaman aşımından daha tehlikelidir.

## 5. Tek kararlık evrakla uçtan uca test: hat çalışıyor

Kontrol testi olarak "2021 1580 - 1635 Encümen Asıl" dosyasının 1. sayfası tek
sayfalık PDF olarak gerçek API'den geçirildi (`/api/uploads` → parça → complete →
`/api/admin/scan` → `/api/jobs/process`):

```
processed: true   pages: 1   durationMs: 52087
profileCode: ENCUMEN_KARARI   fieldValues: 6   suggestedRelations: 1
accessDerivative: false
```

Doğru çıkanlar:

| Alan | Değer | Güven |
|---|---|---:|
| document_date | 31.12.2021 | %99,74 |
| unit | Emlak ve İstimlak Müdürlüğü | %99,74 |
| ada | 152 | %97,71 |
| parcel | 44 | %97,71 |

Varlık ilişkisi `152 ada 44 parsel` (PARCEL, PROVISIONAL) kuruldu, belge `review`
durumuna alındı, sayfa ortalama güveni %98,16. Yükleme→karantina→tarama→terfi→OCR
zinciri, girdi **tek bir karar** olduğunda uçtan uca çalışıyor.

## 6. Aynı testte ortaya çıkan alan çıkarma hataları

1. **Karar numarası hiç yakalanmıyor.** OCR `SAYI: 1635` ifadesini doğru okudu
   ama `ENCUMEN_KARARI` profilinde karar numarası alanı **yok** (profil alanları:
   document_type, unit, document_date, neighborhood, ada, parcel, addressee).
   Encümen arşivinde memurun ilk aradığı bilgi budur; ayrıca toplu dosyayı
   kararlara bölmenin de anahtarı odur.

2. **Mahalle yanlış değer üretti:** `İn İlimiz Merkez Bahtiyarbostan`
   (doğrusu `Bahtiyarbostan`). `MAHALLE` deseni `MAHALLESİ`den önceki bütün
   büyük harf dizisini yutuyor. Alan `risk=LOW` olduğu için personel
   doğrulaması zorunlu değil — yanlış mahalle sessizce arşive girer.

3. **Tarih deseni tarihsel biçimleri kaçırıyor.** `TARIH` yalnız sıfır dolgulu
   `GG.AA.YYYY` eşliyor:

   | Biçim | Kaynak | Sonuç |
   |---|---|---|
   | `24.5.1983` | 1983 Encümen suret | kaçırdı |
   | `26.7.1983` | 1983 Encümen suret | kaçırdı |
   | `11/3/1975` | 1975 Encümen asıl | kaçırdı |
   | `14/3/975` | 1975 Encümen asıl | kaçırdı |
   | `31/12/2021` | 2021 Encümen asıl | eşleşti |

   Yani 1972/1975/1983 külliyatında belge tarihi çıkarımı **%0**.

4. **Çoklu ada/parsel kaçıyor.** `152 ada 42-43-44 nolu parseller` hiç
   eşleşmiyor; test sayfasında yalnız `152/44` yakalandı, oysa metin 42-43-44 ve
   -A-/-B-/-C- parsellerini de içeriyor. Tevhit/ifraz kararlarının tipik
   biçimi bu. Desen satır bazlı çalıştığı için satır sonunda bölünen
   `152 ada` / `44 nolu parselden` çifti de kaybediliyor.

5. **Belge türü yanlış etiketlendi:** "Encümen **Asıl**" dosyasından gelen sayfa
   `Encümen karar sureti` olarak işaretlendi. Asıl/suret ayrımı mevcut tespit
   işaretleriyle yapılamıyor.

6. **PDF'lerde görüntü iyileştirme hiç uygulanmıyor.** `prepare_image`
   (`services/ocr/app/main.py:193`) `content_type.startswith("image/")` değilse
   hemen dönüyor; CLAHE + keskinleştirme yalnız JPEG/PNG yüklemelerinde
   çalışıyor. Soluk 1975/1983 taramaları bu iyileştirmenin asıl hedefiydi.

7. **PDF için görüntüleme türevi üretilmiyor.** `build_access_derivative` de
   yalnız görüntülerde çalışıyor (`accessDerivative: false`), `document-render`
   servisi ise yerelde hiç başlatılmıyor (`scripts/dev-stack.mjs` yalnız OCR +
   tarama taklidini kaldırıyor) ve `.dev.vars` içinde
   `DOCUMENT_RENDER_SERVICE_URL`, `DOCUMENT_RENDER_SERVICE_TOKEN`,
   `DOCUMENT_RENDER_IMAGE_DIGEST` yok — uygulama açılışta bunu uyarı olarak
   yazıyor. Sonuç: yerelde PDF belgenin önizlemesi hiç oluşmaz.

## 6.b Alan çıkarma düzeltmeleri (§6'daki 1, 2, 3, 4 ve 6 giderildi)

Desenler artık satır satır değil **sayfa metninin tamamı** üzerinde çalışıyor ve
eşleşme konumları kelime kutularına geri eşleniyor; satır sınırını aşan
ifadeler ve alt satıra düşen karar numaraları böylece yakalanıyor.

| Bulgu | Durum | Kanıt |
|---|---|---|
| Karar numarası alanı yok | giderildi | `document_number` (VERI_SOZLUGU.md §5) profil çekirdeğine eklendi; şema 30 |
| Mahalle uzun öneki yutuyor | giderildi | `MAHALLESİ` öncesi TEK kelime; sözlük yüklendiğinde çok kelimeli adlar |
| Tarihsel tarih biçimleri | giderildi | tek haneli gün/ay ve 3 haneli yıl; değer `GG.AA.YYYY` sıfır dolgulu |
| Çoklu ada/parsel | giderildi | `42-43-44` üç parsele ayrılıyor; hukuki ek (`12/A`, `12-B`) korunuyor |
| Satır sınırını aşan ada/parsel | giderildi | sayfa genelinde eşleşme; kanıt kutusu iki satırın birleşimi |
| PDF'te CLAHE çalışmıyor | giderildi | sayfa görüntüye render edilip aynı ölçüt ve iyileştirmeden geçiyor |
| Asıl/suret ayrımı | **açık** | kurumun profil envanteri ve tespit işaretleri gerekiyor (§8) |

Gerçek dosyada doğrulama — `1975 - 1 - 600 Encümen Asıl.pdf`, sayfa 17–21
(`model: PP-OCRv5+clahe-auto`, yani iyileştirme gerçekten uygulandı):

| Alan | Çıkan değerler | Önceki durum |
|---|---|---|
| `document_date` | 25.02.1975, 18.02.1975, 29.01.1975, 07.02.1975 | bu külliyatta **%0** |
| `document_number` | 442, 419, 351, 307 | alan hiç yoktu |
| `neighborhood` | Kizilirmak, Sularbaşı | eski kod `Olarak Pulur` üretmişti |
| `ada`/`parcel` | 211/74, 286/45, 288/2, 889/1, 932/64 | ilişkiler kuruldu |

Tarih değerleri `risk=MEDIUM` geliyor: sıfır dolgulu biçim profildeki kalıbı
karşılıyor. Ham biçimde bırakılsalardı kritik alanda biçim ihlali sayılıp
`CRITICAL` olur ve öneri işe yaramazdı.

Bu koşuda bir gerçek hata da yakalandı ve düzeltildi: iyileştirilmiş sayfa tek
kanallı dizi olarak dönüyordu, Paddle'ın belge düzeltme ön işlemcisi ise
`img.shape[2]` okuyor — dilim `IndexError` ile 500 veriyordu. Eski yol
görüntüyü PNG'ye yazdığı için dönüşüm dosya okumada örtük yapılıyordu.

Ölçülen bir sınır: `document_number` sayfa 20'de `1975` gibi yanlış bir aday da
üretebiliyor. Tek değerli alan olduğu için belge kapanışında en güvenli aday
seçilir; ama 487 ayrı karar taşıyan bir dosyada "belgenin karar numarası" zaten
anlamsızdır — bu, §4'teki toplu dosya sorununun bir görünümüdür, desenin değil.

## 6.c Belge türü tespiti (§6'daki 5. bulgunun kod tarafı)

Toplu yükleme denemesi (§11) tespitin iki kusurunu ölçtü ve ikisi de giderildi.

**İşaret gerçek başlıkta hiç eşleşmiyordu.** Tohumdaki işaret `ENCÜMEN KARAR`,
başlık ise `BELEDİYE ENCÜMENİ KARAR`. Üç encümen kararının üçünde de eşleşme
yoktu; tür alanı dolduğunda bu başlıktan değil gövdedeki bir cümleden geliyordu.
Veritabanındaki 26 gerçek sayfanın başlıkları çıkarıldığında sorunun boyutu
görüldü — OCR aynı kelimeyi dört ayrı biçimde veriyor ve okuma sırasını
bozuyor:

| Gerçek başlık (ölçüm) | Kaynak |
|---|---|
| `SÍVAS BELEDİYE ENCÜMENİ KARAR SAYI: 1629` | 2021 |
| `SIVAS BELEDIYE ENCUMENİ KARAR Sayi 565` | 1975 s3 |
| `SIVAS BELEDIYE ENCUMENT KARAR Sayi 542` | 1975 s8 — İ harfi **T** okunmuş |
| `SIVAS KARAR BELEDIYE ENCÜMENİ Sayi 518` | 1975 s11 — **sıra bozuk** |

Bu yüzden eşleşme artık ASCII katlaması üzerinde, kelime ÖNEKİ olarak ve belge
türü işaretlerinde **sıra aranmadan** yapılıyor. Sıra zorlanamaz: `SIVAS KARAR
BELEDIYE ENCÜMENİ` biçimi sıralı eşleşmede kaçar. Müdürlük adları metinde
bitişik öbek olarak geçtiği için orada sıra korunuyor, yalnız ASCII katlaması
ekleniyor — bu da `evrakin Zabita Müdürlüğüne tevdiine` gibi `ı` harfini
kaybetmiş satırları yakalıyor.

**Belgenin konusu, türünü eziyordu.** 2019 cildinin 12. sayfası `İşyeri açma
ruhsatı` olarak etiketlenmişti: başlığı `BELEDİYE ENCÜMENİ KARAR` olmasına
rağmen gövdede ruhsatsız faaliyetten söz edildiği için o türün işareti önce
eşleşiyordu. Tespit artık önce **başlık bölgesini** (ilk 120 karakter) arıyor;
orada eşleşme varsa gövdedeki başka tür işaretleri yok sayılıyor. Başlıkta
hiçbir işaret yoksa gövdeye düşülüyor — 1975 cildinin ilk sayfasında OCR
başlıktaki `ENCÜMENİ` satırını tümüyle kaçırmış ve tür ancak gövdeden
bulunabiliyor.

Ölçülen sonuç, veritabanındaki 26 gerçek sayfa üzerinde:

| | Önce | Sonra |
|---|---:|---:|
| Türü tespit edilen sayfa | 3 (hepsi gövdeden, kazara) | **21** |
| Yanlış tür | 1 (`İşyeri açma ruhsatı`) | **0** |

Uçtan uca kanıt: aynı tuzak sayfa yeni bir belge olarak hattan geçirildiğinde
`profil=ENCUMEN_KARARI`, `tür=Encümen karar sureti` döndü (2 sayfa, 9 alan,
87,4 sn). Müdürlük `Zabıta Müdürlüğü` — gelen yazı gerçekten o müdürlükten
geldiği için bu **doğru**; ilk raporda bunu da hatalı saymıştım, değil.

Kalan sınır: başlıkta hiçbir işaret eşleşmezse gövde yedeği yine yanlış tür
seçebilir. Eskiye göre daha iyi (başlık artık gövdeyi yeniyor) ama tespit hâlâ
`VERIFY_REQUIRED` bir öneridir; memur onaylamadan belge arşive girmez.

## 7. Uygulanan düzeltmeler (1 ve 2)

İlk iki madde uygulandı ve gerçek arşiv dosyasıyla doğrulandı; ayrıntı §9'da.

1. **OCR iş birimi sayfa dilimine indi.** Servis artık belgenin tamamını değil
   sınırlı bir sayfa penceresini işler ve kalan ilk sayfayı `nextPage` ile
   bildirir; uygulama ilerlemeyi `processing_jobs.next_page` / `page_count`
   içinde taşır ve iş kaldığı yerden sürer. Sayfa numaraları belge genelinde
   mutlaktır. Tavan 120 sn'den 5 dakikaya çıkarıldı (içerik taraması ve türev
   üretimiyle aynı mertebe, Cron diliminin 8 dakikalık bütçesinin içinde).
2. **Terk edilen çıkarım artık kuyruğu kilitlemiyor.** Üç ayrı sınır:
   servis kendi bütçesini (`OCR_REQUEST_BUDGET_SECONDS`, öntanımlı 240 sn)
   istemci tavanından kısa tutup elindeki sayfayı bitirince döner; aynı belge
   için ikinci çıkarım 409 ile reddedilir (uygulama bunu arıza saymaz, deneme
   bütçesini harcamaz); kilit başka belgeyle meşgulse istek hızlı 503 verir ve
   istemcinin bütçesini boş beklemeyle tüketmez. Asıl dosya artık SHA-256 ile
   adlandırılan, bayt sınırlı bir önbellekten okunur: dilimler aynı belgeyi
   yeniden indirmez.

## 8. Kalan işler — kod değil KARAR gerektiriyor

Aşağıdaki üç madde kasten yapılmadı: üçü de kurumsal ya da mimari bir karar
istiyor ve yarım bir uygulama, olmayandan daha kötüdür.

1. **Toplu tarama dosyalarını kararlara bölmek.** Seçenekler, ölçümler ve öneri
   `ADR-019-TOPLU-TARAMA-KARAR-BOLME.md` taslağında. Karar numarası alanı artık
   var, yani önkoşul karşılandı. Ama bölme, tek bir yüklemeden N belge kaydı
   üretmek demektir ve bu doğrudan yetkili nesne modeline dokunur: asıl nesne
   değişmezdir (ADR-016) ve her karar kendi aslına mı, yoksa sayfa aralığı
   türevine mi (ADR-015) bağlanacaktır? Ayrıca bölme ancak bütün sayfalar
   okunduktan sonra yapılabilir (623 sayfa ≈ 8,6 saat) ve sınır tespiti eski
   taramalarda hatasız değildir — yanlış bölünmüş bir karar, hiç bölünmemiş
   olandan daha zor düzeltilir. Kararı verilmeden kodlanmamalıdır.

2. **Asıl/suret ayrımı.** Şu an tek bir encümen profili var
   ("Encümen karar sureti") ve her encümen kararı onunla etiketleniyor; bu
   yüzden "Encümen Asıl" dosyasından gelen sayfa da "suret" görünüyor. Doğru
   çözüm ayrı bir profil ve tespit işaretleri tanımlamaktır — bu, sınıflandırma
   verisidir ve sahibi Yazı İşleri Müdürlüğü'dür (profiller `HYPOTHESIS`
   durumunda). Servis kendi sözlüğünü uydurmaz (PROJE_PLANI.md 8. madde), bu
   yüzden işaretler koda gömülmedi. Hafifletici: `document_type` alanı
   `VERIFY_REQUIRED`, yani memur onaylamadan belge arşive girmiyor.

3. **Yerelde PDF önizlemesi.** Denendi ve BLOKE: renderer türev bölümlerini
   doğrudan nesne deposuna (S3) yazıyor, yerelde ise depo Miniflare R2
   emülasyonudur ve S3 ucu yoktur. Okuma tarafı için iç uç var ama o uç
   **bilerek salt-okunur** — üç kilidinden biri budur. Yerel önizleme, iç uca
   bir YAZMA yolu eklemeyi gerektirir ve bu, güvenlik yüzeyini genişleten bir
   tasarım kararıdır; yarım bırakmak yerine geri alındı. Bu koşuda yalnız
   bağımsız bir kusur düzeltildi: renderer `boto3`'ü modül tepesinde içe
   alıyordu ve S3 yolu hiç kullanılmasa bile bağımlılık olmadan açılamıyordu
   (OCR servisi aynı bağımlılığı zaten işlev içinde alıyor).

## 9. Düzeltmelerin gerçek dosyada doğrulanması

Doğrulama, eskiden **her denemede zaman aşımına düşen** dosyayla yapıldı:
`1975 - 1 - 600 Encümen Asıl.pdf`, 408.081.441 bayt, 623 sayfa.

| Dilim | Yanıt | Süre | İşlenen sayfa | `nextPage` | Alan | Profil |
|---|---|---:|---|---:|---:|---|
| 1 | `200 processed:true completed:false` | 248,2 sn | 1–5 | 6 | 2 | TASNIF_BEKLIYOR |
| 2 | `200 processed:true completed:false` | 260,7 sn | 6–10 | 11 | 6 | ENCUMEN_KARARI |
| 3 | `200 processed:true completed:false` | 292,6 sn | 11–16 | 17 | 2 | ENCUMEN_KARARI |

Doğrulanan davranışlar:

- Belgenin sayfa sayısı (**623**) ilk dilimde doğru bildirildi ve işte saklandı.
- İş her dilimden sonra `queued` ve `attempt = 0` kaldı: ilerleyen dilim deneme
  bütçesini tüketmiyor.
- Devam dilimi önceki sayfaları **silmedi**: `ocr_pages` içinde 1–16 arası 16
  sayfa birikti (sayfa metinleri 1.107–2.129 karakter, ortalama güven
  %83,8–%94,7).
- Belge yarıda `review` durumuna **geçmedi**; hâlâ `queued`. Eksik metinli bir
  belge doğrulamaya açılmıyor.
- Çok değerli alanlar dilimler arasında birikti ve `value_index` bitişik kaldı
  (ada/parsel: 932/64 → sayfa 3, 288/2 ve 286/45 → sayfa 7).
- Belge türü ikinci dilimde tespit edildi ve profil TASNIF_BEKLIYOR'dan
  ENCUMEN_KARARI'ya geçti.
- Asıl dosya önbellekte **tek kopya** (389,2 MB): dilimler dosyayı yeniden
  indirmiyor. Düzeltmeden önce aynı dosyanın dört kopyası birikmişti.
- Dilim sürerken gelen ikinci istek `200 processed:false` ve
  "Belgenin OCR işlemi hâlihazırda sürüyor." mesajıyla döndü; iş bozulmadı.

**Hız değişmedi, davranış değişti.** Sayfa başına maliyet hâlâ ~50 sn: 623
sayfalık bu dosya toplam ~8,6 saat sürekli işlem demektir. Düzeltme işi
hızlandırmaz; **başarısız olmak yerine ilerlemesini** sağlar. Arşivin tamamı
(7.029 sayfa) bu hızda ~98 saattir ve bu, tek makine/tek uçuş sınırının
sonucudur — kısaltmak için ayrı bir karar gerekir (daha fazla çalışan, GPU veya
metin katmanı iyi olan modern dosyalarda OCR'ı atlamak).

Regresyon koruması: `tests/ocr-page-window.test.ts` (6 davranış testi, gerçek
rota + gerçek şema + SQLite) ve `services/ocr/tests/test_page_window.py`
(10 test: pencere sınırı, bütçe, mutlak sayfa numarası, tek uçuş koruması).
`npm run verify` 440 testle temiz geçiyor.

## 10. Toplu dosya yükleme denemesi

**Böyle bir özellik yok.** Üç yüzeyin hepsi tek dosya alıyor:

- `app/archive/upload-dialog.tsx` — `type="file"` girişinde `multiple` yok ve
  `files?.item(0)` ile yalnız ilk dosya alınıyor;
- aynı dosyada sürükle-bırak da `dataTransfer.files.item(0)` — beş dosya
  bırakıldığında dördü **sessizce** düşer;
- `app/archive/mobile-scan.tsx` — kamera ve galeri girişleri de tekil.

Arayüzde geçen "toplu" ifadeleri toplu **parsel onayı** paneline aittir.

Buna karşılık **arka uç N belgeyi taşıyor.** Bir toplu yükleyicinin altta
yapacağı iş elle koşturuldu: dört ayrı cilt sayfası arka arkaya hattan
geçirildi.

| Aşama | Sonuç |
|---|---|
| Dört dosya karantinaya | 1,3 sn; dördü de `QUARANTINED` |
| Tarama + terfi turları | Tur 1'de 3, tur 2'de 1 → dördü `ACCEPTED` |
| Belge kaydı | 4/4 oluştu |
| OCR (sırayla) | 72,6 / 48,0 / 44,0 / 47,0 sn — dördü `review` |

Tur başına üç belgenin terfi etmesi tesadüf değil: `lib/scheduled-jobs.ts` turu
üç işle sınırlıyor. Yani toplu yükleme büyük ölçüde **arayüz işi**; kabul
zinciri, terfi ve OCR kuyruğu birden çok belgeyi hâlihazırda taşıyor.

Denemenin asıl getirisi özellik değil, §6.c'de düzeltilen iki tespit kusurunun
ortaya çıkması oldu. Üçüncü bulgu: yürürlükteki altı profil arasında **meclis
belgesi yok**, oysa arşivde iki meclis cildi (515 sayfa) var. Bu sınıflandırma
verisidir ve §8'deki gerekçeyle uydurulmadı; ölçümler, doğrulanmış tespit
işaretleri ve dört profillik öneri `MECLIS_PROFIL_ONERISI.md` taslağında.

## 11. Hız ölçümleri — ayar değil, bellek

İşletim kuralları `OCR_ISLETIM_KURALLARI.md` içindedir; buradaki bölüm o
kuralların dayandığı ölçümdür. Örnek küme her dönemden birer gerçek sayfadır
(1972, 1975, 1983, 2019, 2020, 2021) ve her varyantta süreyle birlikte satır
sayısı, güven ve **gerçek alan çıkarımı** kaydedilmiştir — hız uğruna veri
kaybını görmek için.

### Motor ayarı: altı deneme, altısı da kayıp

| Varyant | Ort. sn/sayfa | Toplam satır | Temele göre kaybedilen alan |
|---|---:|---:|---|
| **Temel (bugün)** | **43,9** | 292 | — |
| Unwarp kapalı | 45,4 | 303 | 4 |
| +Yön sınıflandırma kapalı | 44,3 | 303 | 4 |
| İş parçacığı 16 | 58,8 | 303 | 4 |
| İş parçacığı 2 | 63,9 | 284 | — |
| Render 150 dpi | 46,4 | 279 | — |
| Render 137 dpi | 44,5 | 284 | 2 |
| Mobil tespit modeli | **249,2** (1 sayfa) | — | eleme |

Kaybedilen alanlar somut: 1983'ün iki belge tarihi, 2020'nin karar numarası
(854), 1972'nin müdürlüğü, 1975'in belge tarihi. Yani yardımcı modelleri
kapatmak veya çözünürlüğü düşürmek bedava tasarruf değil, bedelsiz kayıptır.

Çözünürlüğün işe yaramamasının sebebi yapısaldır: tespit girdisi
`PADDLEOCR_DET_LIMIT_SIDE_LEN=1600` ile zaten küçültülüyor, tanıma kırpmaları da
sabit yüksekliğe normalleştiriliyor. 200 dpi ile 137 dpi aynı tespit işini
yapıyor; fark yalnız okunan metinde kalıyor (303 → 284 satır).

### Paralellik: tavanı CPU değil bellek koyuyor

| İşçi | sn/sayfa | Saatte sayfa | Sonuç |
|---:|---:|---:|---|
| 1 | **40,7** | **88** | en iyi |
| 2 | 155,9 | 46 | verim yarıya düştü |
| 3 | — | 0 | hiçbir işçi başlayamadı |
| 4 | 106,1 | 68 | dört işçinin yalnız ikisi hayatta kaldı |

Ölçülen sebep: işçi başına **4.841 MB RSS**. İki işçi 15,7 GB'lık makinenin
9,7 GB'ını alıyor, boş RAM 0,31 GB'a iniyor, sistem takas belleğine giriyor —
ısınma 29 sn'den 140 sn'ye, sayfa süresi 40,7'den 156 sn'ye çıkıyor. 20 çekirdek
boşta durur ama kullanılamaz.

Ölçüm sırasında iki tuzak da belgelendi: `OMP_NUM_THREADS=4` vermek **segfault**
üretiyor (bu Paddle derlemesi OpenBLAS ile yapılmış ve çok iş parçacığını
desteklemiyor), Windows'ta `multiprocessing` spawn ise Store `python` ara
katmanıyla birleşince çocuk süreçleri hiç başlatmadan kilitliyor.

### Metin katmanı kapısı: ölçülen tek gerçek kazanç

Elde hem gömülü katman hem gerçek OCR bulunan 12 sayfa karşılaştırıldı. Ayırt
edici sinyal Türkçe harf oranı: geçen tek sayfada %9,6 ve OCR'a %70 benzerlik,
diğer hepsinde **%0** ve `say1lt`, `1le` gibi rakam-harf karışmaları.

| Cilt | Sayfa | Kapıyı geçen |
|---|---:|---:|
| 2021 1-75 Encümen Asıl | 459 | 302 (%65,8) |
| 2021 1-30 Meclis | 178 | 124 (%69,7) |
| Diğer altı cilt | 6.392 | 0 |
| **Toplam** | **7.029** | **426 (%6,1)** |

Aynı yılın iki encümen cildinden biri %65,8 geçerken öbürü hiç geçmiyor; karar
bu yüzden cilt başına değil **sayfa başına** verilir.

Uçtan uca doğrulama: `2021 1-75` cildinden üç sayfa gerçek hattan geçirildi ve
**0,2 saniyede** tamamlandı (OCR ile ~120 sn), dokuz alan çıktı
(`ada=1104`, `parcel=16`, `document_date=19.01.2021`, müdürlük, iki mahalle) ve
`ocr_pages.model` değeri üç sayfada `pdf-text-layer` yazıldı.

### Takvim

| Senaryo | Sayfa | Süre |
|---|---:|---:|
| Bugün, kapı yok | 7.029 | 79,5 saat |
| Kapı ile (uygulandı) | 6.603 | **74,7 saat** |
| 32 GB RAM + 4 işçi | 6.603 | **18,7 saat** |

Yazılım tarafında yapılacak iş bitti. Kalan dört kat hızlanma bir bellek
boyutlandırma kararıdır, ayar meselesi değil.

## 12. Test sırasında ortamda yapılanlar

- Tıkanmış OCR süreci durduruldu; servis düzeltmelerden sonra yeni kodla,
  ısınmış olarak yeniden başlatıldı (`:8090`, `modelReady: true`). Kullanıcının
  `:3000` üzerindeki geliştirme sunucusuna ve `:8091` tarama taklidine
  dokunulmadı. `npm run dev:hizmetler` yığınının kendi OCR alt süreci ölü;
  yığını Ctrl+C ile kapatıp yeniden başlatmak temiz durumu geri getirir.
- Yerel geliştirme şeması 28'den **30**'a göç etti (29: `next_page` /
  `page_count`; 30: `document_number` alanı ve alan sırası hizalaması). Göç,
  yarım kalmış OCR işlerini sıfırlar.
- Uygulama sunucusu bir ara kapalıydı; toplu yükleme denemesi için yeniden
  başlatıldı (`:3000`).
- Yerel geliştirme veritabanına altı test belgesi eklendi (hepsi `review`
  durumunda, arayüzden incelenebilir): `ornek-2021-encumen.pdf`,
  `karar-a/b/c/d.pdf` ve `ruhsat-tuzagi.pdf`. `karar-c.pdf` düzeltmeden ÖNCE
  işlendiği için hâlâ `İşyeri açma ruhsatı` görünür; aynı içerik düzeltmeden
  sonra `ruhsat-tuzagi.pdf` olarak `Encümen karar sureti` döndü. Tasnifi
  yapılmış bir belgenin türü OCR tarafından değiştirilmediği için karar-c
  kendiliğinden düzelmez.
- Eski koddan kalan, `%TEMP%` içindeki 1.557 MB'lık sızmış geçici PDF
  **silinmedi** (yeni kod artık bunları üretmiyor); temizlik için:

  ```bash
  Get-ChildItem $env:TEMP -Filter "tmp*.pdf" | Where-Object Length -gt 100MB | Remove-Item
  ```

- 1975 belgesinin işi **21/623 sayfada, `queued`** durumda duruyor ve kaldığı
  yerden sürecek. Yerelde OCR cron'u ateşlenmediği için kendiliğinden
  ilerlemez; `POST /api/jobs/process?documentId=…` her çağrıldığında bir dilim
  daha işler.
