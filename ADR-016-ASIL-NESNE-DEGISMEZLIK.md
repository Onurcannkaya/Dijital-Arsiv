# ADR-016 — Asıl Nesne Değişmezliği, Sürümleme ve WORM Profili

- Durum: Teknik hedef kabul edildi — kurumsal saklama ve hukuk onayı bekliyor
- Tarih: 2026-07-30
- Kapsam: Kabul edilmiş `original` nesneler, yasal bekletme ve tasfiye
- Sahip: Bilgi İşlem
- Gerekli kurumsal onaylar: Bilgi İşlem, Bilgi Güvenliği, Arşiv, Hukuk/KVKK

## Bağlam

Uygulama düzeyinde aynı anahtara yazmamak gerekli fakat tek başına yeterli
değildir. Yanlış yetkilendirilmiş yönetici, sağlayıcı konsolu, silme anahtarı
veya yaşam döngüsü kuralı asıl nesneyi değiştirebilir. Buna karşılık onaylanmamış
bir saklama süresini değiştirilemez kilit olarak uygulamak da hatalı veriyi
gereksiz ve hukuka aykırı biçimde tutabilir.

Cloudflare R2 bucket lock, silme ve üzerine yazmayı süre/prefix kuralıyla
engelleyebilir; ancak S3 Object Lock'un nesne bazlı retention mode ve legal hold
sözleşmesiyle aynı yetenek değildir. Bu nedenle R2 pilotu mevzuatsal WORM
uyumluluğu iddia edemez.

## Karar

### Uygulama ve kimlik düzeyi

- Asıl anahtara yalnız `ImmutableVaultWriter.putIfAbsent/promote` ile ilk yazma
  yapılır.
- Normal uygulama, OCR, görüntüleme ve bütünlük rolleri aslı güncelleyemez veya
  silemez.
- Tasfiye yetkisi ayrı kimlik, kurul/onay kaydı ve dört göz ilkesi gerektirir.
- Düzeltme yeni nesne ve sürüm ilişkisi üretir; önceki asıl değişmez.
- Yazma sonrasında nesne tam okunur; SHA-256 ve boyut kabul alındısıyla eşleşmeden
  belge `ACCEPTED` olmaz.

### Üretim asıl kasası

Üretim sağlayıcısı aşağıdaki profili sağlamadan asıl kasa olarak kabul edilmez:

- sürümleme açık;
- kabul edilmiş asıllarda S3 Object Lock **compliance mode** veya bağımsız testle
  aynı sonucu veren nesne bazlı WORM;
- saklama bitişi onaylı dosya/saklama planından hesaplanır;
- saklama süresi kısaltılamaz, yalnız yetkili kararla uzatılabilir;
- belge bazlı legal hold/yasal bekletme vardır;
- çoğaltma ve geri yüklemede retention ile legal hold korunur;
- saat, yönetici, olağanüstü erişim ve sağlayıcıdan çıkış kontrolleri
  kanıtlanır.

Kurumsal dosya planı ve saklama başlangıç olayı onaylanmadan üretim aslı
kilitlenmez ve gerçek üretim belgesi kabul edilmez. Teknik ekip saklama süresini
uyduramaz. Bu koşul Faz 1 geliştirmesini engellemez; üretim açılış kapısıdır.

### R2 pilot profili

Pilot yalnız sentetik veya açıkça pilot olarak yetkilendirilmiş veri kullanır.
`ORIGINAL_FILES` alanında:

- normal çalışma kimliklerinde silme/güncelleme yetkisi bulunmaz;
- koşullu oluşturma ve yazma sonrası doğrulama uygulanır;
- ayrı yapılandırma yöneticisiyle süreli R2 bucket lock testi yapılır;
- bucket lock kaldırma yetkisi uygulama ve depolama işletim rollerinde bulunmaz;
- sonuç “R2 pilot değişmezlik kontrolü” olarak raporlanır, S3 Object Lock veya
  hukuki WORM kanıtı sayılmaz.

R2 bucket lock sağlayıcı sınırı nedeniyle §19 Test 7'nin Object Lock/legal hold
bölümü pilotta **uygulanamaz** olarak, gerekçesi ve bu ADR ile sonuçlandırılır.
Üretim sağlayıcı kabulünde Test 7 bütünüyle uygulanır ve geçmeden üretim açılmaz.

## Tasfiye

Saklama süresinin dolması otomatik silme emri değildir. Tasfiye için:

1. arşiv/hukuk tarafından onaylanmış kapsam ve gerekçe;
2. etkin legal hold bulunmadığı doğrulaması;
3. iki ayrı yetkili onayı;
4. asıl, türev, çoğaltma ve yedek etkisini gösteren plan;
5. ayrı `DispositionStorage` kimliğiyle yürütme;
6. sonuç ve başarısızlıkların değişmez denetim kaydı

zorunludur.

## Sonuçlar

- R2 pilotu ile üretim WORM iddiası birbirine karıştırılmaz.
- Üretim sağlayıcı seçimi Object Lock/legal hold yeteneğiyle sınırlandırılır.
- Saklama planı onayı üretim ön koşulu hâline gelir.
- Compliance mode yanlış yapılandırılırsa geri döndürülemez sonuç doğuracağı için
  karantina ve kabul doğrulaması kilitten önce tamamlanır.

## Doğrulama

- Aynı anahtara ikinci yazma ve normal rolle silme reddedilir.
- Yazma sonrası tam SHA doğrulaması geçmeden `ACCEPTED` oluşmaz.
- Pilot bucket lock altında kontrollü silme/üzerine yazma reddedilir.
- Üretim sağlayıcı testinde compliance retention ve legal hold ayrı ayrı sınanır.
- Tasfiye rolü normal uygulama kimliğine bağlanamaz.

## Sağlayıcı dayanağı

- Cloudflare R2 bucket locks:
  https://developers.cloudflare.com/r2/buckets/bucket-locks/

