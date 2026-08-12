# ADR-015 — PDF Erişim Türevi ve Renderer Güvenlik Profili

- Durum: Teknik karar kabul edildi — kurumsal onay bekliyor
- Tarih: 2026-07-30
- Kapsam: PDF asılların güvenli görüntüleme türevleri ve geri dolumu
- Sahip: Bilgi İşlem
- Gerekli kurumsal onaylar: Bilgi İşlem, Bilgi Güvenliği, Arşiv, Erişilebilirlik sorumlusu

## Bağlam

Mevcut uygulama PDF için erişim türevi üretemediğinde asıl PDF'yi görüntüleme
yoluna verebilir. Aktif içerik, betik, form, gömülü dosya, dış bağlantı ve bozuk
nesne yapısı taşıyabilen güvenilmeyen PDF'nin doğrudan tarayıcıya sunulması kabul
hattındaki karantina sınırını zayıflatır.

## Karar

PDF asıl hiçbir zaman normal görüntüleme rolüne geri düşmez. Görüntüleme yalnız
`access` sınıfındaki güvenli türev üzerinden yapılır. Yetkili asıl indirme ayrı
iş amacı, ayrı rol ve denetim olayı gerektirir.

İlk Faz 1 renderer profili:

- PDFium tabanlı, sürümü ve imaj özeti sabitlenmiş ayrı
  `services/document-render` servisi;
- Worker veya web süreci dışında, dış ağa kapalı, ayrıcalıksız ve kaynak
  sınırlı konteyner;
- her sayfayı sRGB renk uzayında **150 DPI** raster görüntüye yeniden çizme;
- sayfaları web görüntülemeye uygun, **doğrusallaştırılmış** (linearized /
  fast web view) yeni bir erişim PDF'sinde birleştirme; böylece görüntüleme
  oturumu range istekleriyle ilk sayfaları belgenin tamamı inmeden sunabilir;
- kaynak PDF'deki JavaScript, form eylemi, ek dosya, video/ses, katman,
  açıklama eylemi, harici başvuru ve özgün metadata'yı taşımama;
- çıktı PDF'sine yalnız sistem nesne kimliği, üretici adı/sürümü ve oluşturma
  zamanı gibi kişisel veri içermeyen teknik metadata yazma;
- PDF başına en çok **2.000 sayfa**, açılmış sayfa başına en çok
  **100 megapiksel** ve erişim türevinde en çok **512 MiB**.

512 MiB türev sınırını tek bölümde aşacak belge reddedilmez; sayfa aralıklı
birden çok erişim bölümü üretilir. Her bölüm kendi `binary_objects` kaydı,
`derived_from_id` bağı, sayfa aralığı ve SHA-256 değeriyle yazılır; görüntüleyici
bölümleri sırayla sunar. Böylece 2 GiB'a kadar kabul edilen hiçbir belge yalnız
boyutu nedeniyle görüntülenemez kalmaz.

Sayfa veya megapiksel sınırını aşan, parola korumalı, bozuk veya renderer zaman
aşımına uğrayan PDF için asıl PDF'ye asla geri dönüş yapılmaz. İş
`DERIVATIVE_REVIEW_REQUIRED` durumuna alınır; bu durum türev işi sözleşmesine
aittir, ADR-013 kabul durum makinesine karışmaz ve işletim metriği olarak
izlenir. Kullanıcıya güvenli türevin hazırlanamadığı bildirilir. Açık yetkili
asıl indirme yolu bu durumdan bağımsızdır.

## Metin katmanı ve erişilebilirlik

İlk erişim PDF'si, doğrulanmamış OCR metnini görünmez katman olarak taşımaz.
Onaylanmış OCR metni varsa ikinci sürüm erişim türevi üretilebilir ve üretici
sürümüyle kaydedilir. Metin katmanı kaynak sayfa koordinatına bağlanır; önceki
türev üzerine yazılmaz.

Raster erişim PDF'sinin tam etiketli PDF erişilebilirliği sağlamadığı açık bir
sınırlamadır. Pilot görüntüleyici en az:

- belge için erişilebilir ad;
- sayfa numarası ve toplam sayfa bilgisi;
- klavye ile sayfa gezinmesi;
- onaylanmış OCR metnine ayrı erişilebilir panel

sağlar. Uzun dönem koruma çıktısı ve tam etiketli erişilebilir PDF bu erişim
türeviyle aynı nesne sayılmaz.

## Görüntüleme ve indirme bileti

Uygulama sağlayıcının yeniden kullanılabilir ön imzalı URL'sini erişim kararı
olarak kullanıcıya vermez. Uygulama tarafından üretilen rastgele en az 256 bitlik
opak biletin yalnız özeti veritabanında tutulur.

- Görüntüleme değişim bileti **60 saniye** geçerlidir ve bir kez tüketilir.
- Başarılı değişim, kullanıcı+belge+nesne sınıfı+amaç kapsamına bağlı bir
  görüntüleme oturumu üretir. Oturum **15 dakika boşta kalma**, en çok
  **30 dakika mutlak süre** sınırına sahiptir ve PDF range isteklerini destekler.
- Açık indirme bileti ayrı `DOWNLOAD_ORIGINAL` veya `DOWNLOAD_ACCESS` yetkisi
  gerektirir, **60 saniye** geçerlidir ve tek kullanımlıdır.
- Bilet veya oturum başka kullanıcı, belge, nesne sınıfı ya da amaç için
  kullanılamaz; tüketim ve red denetim olayına yazılır.

Bu iki aşama, PDF görüntüleyicilerin çoklu range isteğini desteklerken ele
geçirilmiş ilk bileti yeniden kullanılabilir erişim anahtarına dönüştürmez.

## Türetme ve geri dolum

Her türev yeni `binary_objects` kaydıdır ve en az `derived_from_id`, renderer
adı/sürümü, profil sürümü, sayfa sayısı, boyut ve SHA-256 taşır. Asıl nesne
anahtarı, sürümü ve SHA değeri değişmez.

Mevcut PDF'ler için idempotent geri dolum işi:

1. `access` türevi olmayan kabul edilmiş PDF'leri sayfalı listeler.
2. Belge başına benzersiz türetme anahtarıyla görev oluşturur.
3. Türevi koşullu yazar ve yazma sonrası tam SHA doğrular.
4. Başarı, tekrar veya dead-letter sonucunu kalıcılaştırır.
5. Bütün eksik türevler tamamlanmadan asla asıl PDF fallback'i açmaz.

## Sonuçlar

- Güvenilmeyen PDF etkin özellikleri tarayıcıya taşınmaz.
- Görüntüleme kalitesi ile uzun dönem koruma/PDF-A amacı ayrılır.
- Raster türevler depolama hacmini artırır ve ilk sürümde PDF içi erişilebilirlik
  sınırlıdır.
- Renderer değişikliği profil sürümü ve yeniden üretim gerektirir.

## Doğrulama

- JavaScript, form ve ek dosya içeren kontrollü PDF'nin türevinde bu öğeler yoktur.
- Asıl PDF'nin SHA, sürüm ve anahtarı türetme öncesi/sonrası aynıdır.
- 512 MiB'ı aşan kontrollü belge sayfa aralıklı bölümlerle görüntülenebilir kalır.
- Üretilen erişim PDF'si doğrusallaştırma denetiminden geçer; ilk sayfa, belge
  tamamı inmeden range istekleriyle sunulabilir.
- Renderer çöktüğünde veya sınır aşıldığında asıl PDF görüntülemeye sunulmaz.
- Aynı geri dolum görevi ikinci türev oluşturmaz.
- Renderer adı, imaj özeti ve profil sürümü kanıt paketine girer.

