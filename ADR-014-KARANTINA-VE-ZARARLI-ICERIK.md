# ADR-014 — Karantina Topolojisi ve Zararlı İçerik Taraması

- Durum: Teknik karar kabul edildi — kurumsal onay bekliyor
- Tarih: 2026-07-30
- Kapsam: Kabul öncesi geçici nesneler, karantina ve zararlı içerik taraması
- Sahip: Bilgi İşlem
- Gerekli kurumsal onaylar: Bilgi İşlem, Bilgi Güvenliği

## Bağlam

Güvenilmeyen dosyanın kabul edilmiş asılla aynı yetki alanına yazılması; zararlı
içeriğin görüntüleme, OCR veya normal uygulama rolleri tarafından okunabilmesine
yol açar. Yalnız TypeScript arayüzünden bir metodu kaldırmak fiziksel görev
ayrılığı sağlamaz.

## Karar

Pilot ve üretim topolojisi en az dört ayrı depolama yetki alanı kullanır:

| Yetki alanı | İçerik | Yazabilen | Okuyabilen | Silebilen |
|---|---|---|---|---|
| `TEMPORARY_FILES` | Multipart parçaları ve tamamlanmamış yüklemeler | Yükleme servisi | Yükleme servisi | Süre sonu temizlik servisi |
| `QUARANTINE_FILES` | Tamamlanmış fakat kabul edilmemiş nesne | Yükleme/tamamlama servisi | Tarama ve terfi servisleri | Karantina temizlik servisi |
| `ORIGINAL_FILES` | Kabul edilmiş asıl | Yalnız terfi servisi, koşullu oluşturma | OCR, koruma ve açık yetkili asıl indirme rolleri | Normal çalışma rollerinde hiçbiri |
| `DERIVATIVE_FILES` | Erişim, OCR ve koruma türevleri | İlgili türetme servisi | Görüntüleme/koruma rolleri | Politika kontrollü türev temizlik rolü |

Bu alanlar ayrı kova veya eşdeğer fiziksel namespace olur. Her servis kimliği
kova ve işlem düzeyinde sınırlandırılır. Normal uygulama Worker'ı bütün bağları
aynı anda alamaz. Kullanıcıya kalıcı S3/R2 kimlik bilgisi verilmez.

## Tarama profili

Faz 1 birincil zararlı içerik motoru, sürümü imajda sabitlenmiş ClamAV tabanlı
izole `services/content-scan` servisidir. İmza veritabanı çalışma zamanında
yetkili güncelleme kanalıyla yenilenir; her sonuçta motor, motor sürümü, imza
sürümü ve tarama zamanı kaydedilir.

Tarama servisi:

- belgeyi Worker belleğinden veya HTTP form gövdesinden almaz;
- yalnız karantina nesne kimliği alır ve salt-okunur karantina kimliğiyle
  nesneyi akışla yerel, boyut sınırlı geçici alana indirir;
- dış ağ erişimi, imza güncelleme ucu dışında kapalı; ayrıcalıksız kullanıcı,
  salt-okunur kök dosya sistemi, işlem/bellek/süre sınırı ve seccomp benzeri
  çalışma zamanı kısıtlarıyla çalışır;
- desteklenen azami belge boyutunun tamamını tarayamadığında temiz sonucu
  üretmez;
- EICAR kabul testi ve kontrollü ayrıştırıcı hata testini geçer.

Tarama servisinin geçici disk kapasitesi en az *eşzamanlı tarama sayısı × azami
belge boyutu* artı güvenli baş boşluğu olarak planlanır; eşzamanlı tarama sınırı
ve disk boyutu işletim rehberinde sabitlenir.
Tarama çağrıları `content_scan_jobs` tablosunda istek başına kira, azami deneme,
exponential backoff ve dead-letter durumuyla izlenir. Servis veya imza veritabanı
kullanılamadığında oturum ve nesne `QUARANTINED` kalır; başarısız deneme ayrı,
değiştirilemez `FAILED` alındısı üretir. Yalnız magic-byte, uzantı, güvenli
ayrıştırıcı ve ClamAV sonucu birlikte temizse `VERIFIED` geçişi yapılır.

ClamAV sonucu tek başına tür güvenliği değildir. Magic-byte doğrulaması ve güvenli
ayrıştırıcı profili ayrıca çalışır. PDF içeriğinin güvenli erişim türevine
dönüştürülmesi ADR-015 kapsamındadır.

Tarama servisi kullanılamaz, imza yaşı 24 saati aşmış, tarama zaman aşımına
uğramış veya motor bütün nesneyi tarayamamışsa sistem açık geçmez. Oturum
`SCAN_UNAVAILABLE` ile karantinada kalır ve tekrar/dead-letter görünürlüğü
oluşur.

## Yaşam döngüsü

- Tamamlanmamış `temporary` oturum 24 saat sonra uygulama işiyle iptal edilir.
  Temizlik, multipart/geçici nesneyi siler ve oturumu `EXPIRED` yapar; oturum ile
  değiştirilemez olay/alındı satırları denetim kanıtı olarak fiziksel silinmez.
- Sağlayıcı yaşam döngüsü, tamamlanmamış multipart yüklemeyi en geç 7 günde
  ikinci güvenlik ağı olarak sonlandırır.
- Kabul edilip terfi eden karantina nesnesi doğrulanmış asıl kaydı oluştuktan
  sonra en geç 1 saat içinde yetkili temizlik rolüyle kaldırılır.
- `FAILED` oturumun karantina nesnesi, kök neden incelemesi ve ADR-013'teki
  yetkili yeniden deneme penceresi için 7 gün tutulur; ardından temizlenir.
- `DUPLICATE` sonucuyla kapanan oturumun karantina nesnesi, aynı içerik
  doğrulanmış asıl olarak zaten kasada bulunduğundan en geç 24 saat içinde
  yetkili temizlik rolüyle kaldırılır.
- Reddedilen nesne olay incelemesi için 72 saat izole tutulur, ardından silinir.
- Açık güvenlik olayı varsa Bilgi Güvenliği süreli olay bekletmesi koyabilir;
  karantina saklama süresi kurumsal arşiv saklama süresi sayılmaz.

## Multipart pilot profili

- Azami tek belge boyutu: **2 GiB**.
- Multipart eşiği: **32 MiB**.
- Parça boyutu: son parça hariç **16 MiB**.
- İstemci başına eşzamanlı parça sayısı: en çok **4**.
- Yükleme oturumu süresi: **24 saat**.
- Bir parça için verilen yazma yetkisi: en çok **15 dakika**, yalnız tek oturum,
  parça numarası, boyut aralığı ve checksum kapsamı.

Bu profil 2 GiB belgede en çok 128 parça üretir ve yaygın S3 uyumlu
sağlayıcıların 5 MiB asgari parça sınırının üzerindedir. Sağlayıcı ETag'i içerik
SHA-256 kanıtı sayılmaz. Sunucu SHA-256 değeri tamamlanmış karantina nesnesinin
tamamı akışla okunarak hesaplanır.

Profil pilot ölçümleriyle küçültülebilir veya büyütülebilir; azami boyut artışı
bellek, tarama süresi, geçici disk, zaman aşımı ve yedekleme testleri yeniden
geçmeden devreye alınmaz.

## Sonuçlar

- Zararlı içerik normal görüntüleme ve OCR yolundan fiziksel olarak ayrılır.
- Tarama servisi arızasında kabul durur; güvenlik kontrolü atlanmaz.
- Büyük dosyalar Worker belleğinde tam tamponlanmaz.
- Dört ayrı yetki alanı ve en az beş ayrı servis kimliği işletim maliyeti getirir.

## Doğrulama

- Normal uygulama ve görüntüleme rolleri karantina nesnesini okuyamaz.
- Tarama rolü asıl kasaya yazamaz veya aslı silemez.
- EICAR dosyası `REJECTED` olur ve `ORIGINAL_FILES` alanına geçmez.
- Güncel olmayan imza veya tarama zaman aşımı temiz sonuç sayılmaz.
- 2 GiB profilinin sınır ve kesinti senaryosu bellek artışı olmadan geçer.

## Sağlayıcı dayanakları

- Cloudflare R2 multipart sınırları:
  https://developers.cloudflare.com/r2/objects/upload-objects/
- Amazon S3 multipart sınırları:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html

