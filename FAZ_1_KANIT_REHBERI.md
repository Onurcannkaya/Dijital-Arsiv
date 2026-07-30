# Faz 1 — Kabul ve Kanıt Rehberi

- Durum: Teknik sözleşme tamamlandı — sorumlu birim onayları bekliyor
- Tarih: 2026-07-30
- Kapsam: S3 politikası §19 testleri, kabul hattı güvenlik testleri ve Faz 1 çıkış kapısı
- Süreç sahibi: Bilgi İşlem

## 1. Amaç

Bu rehber “kod mevcut” sonucunu “kontrol gerçek ortamda kanıtla geçti” sonucundan
ayırır. Her koşu belirli commit, şema, ortam ve depolama adaptörüne bağlanır.
Gerçek belge içeriği, kişisel veri ve sır kanıt paketine alınmaz.

Dayanak kararlar:

- `ADR-013-KABUL-DURUM-MAKINESI.md`
- `ADR-014-KARANTINA-VE-ZARARLI-ICERIK.md`
- `ADR-015-PDF-ERISIM-TUREVI.md`
- `ADR-016-ASIL-NESNE-DEGISMEZLIK.md`
- `ADR-017-YEDEK-VE-TASINABILIRLIK.md`
- `S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md`

## 2. Sonuç sözleşmesi

Her test yalnız şu sonuçlardan birini alır:

| Sonuç | Anlam |
|---|---|
| `PASS` | Ön koşullar sağlandı, beklenen sonuç ve zorunlu kanıt oluştu |
| `FAIL` | Kontrol veya kanıt beklentisi karşılanmadı |
| `BLOCKED` | Dış ön koşul eksik; başarılı sayılamaz |
| `NOT_APPLICABLE` | Yalnız yetkili ADR kararıyla teknik olarak uygulanamaz; gerekçe ve onay zorunlu |

`SKIPPED`, boş hücre veya yalnız ekran görüntüsü başarı değildir. Çıkış kapısında
12 politika testinin tamamı sonuçlandırılır; uygulanabilir testlerin tamamı
`PASS`, uygulanamaz testler yetkili `NOT_APPLICABLE` olmalıdır. Herhangi bir
`FAIL` veya `BLOCKED` kapıyı kapatır.

R2 pilotunda Test 7'nin S3 Object Lock/legal hold bölümü ADR-016 gereği
`NOT_APPLICABLE` olabilir; bucket lock telafi kontrolü ayrıca `PASS` olmalıdır.
Üretim asıl kasası kabulünde Test 7 bütünüyle uygulanır ve `PASS` zorunludur.

## 3. Koşu kimliği ve değişmez manifest

Her staging koşusu rastgele bir `run_id` üretir. Kanıt manifesti en az:

- `run_id`, Git commit SHA, uygulama ve şema sürümü;
- UTC başlangıç/bitiş zamanı;
- `staging` ortamı ve test namespace/bucket kimliği;
- adaptör ve gizli olmayan sağlayıcı profil sürümü;
- testi başlatan kurumsal kimlik ve onaylayan roller;
- her test için sonuç, süre, korelasyon kimliği ve sabit hata kodu;
- kanıt dosyalarının SHA-256 değerleri

içerir. Manifest koşu sonunda koşullu yazmayla yalnız oluşturulur; üzerine
yazılmaz. Düzeltme yeni `run_id` üretir.

## 4. Test verisi

Testler ayrı staging alanında sentetik veriyle çalışır:

- `safe-small.pdf`: tek sayfa, aktif içeriksiz sentetik PDF;
- `safe-large.bin/pdf`: ADR-014 azami profil ve parça sınırını doğrulayan sentetik veri;
- `active-content.pdf`: JavaScript/form/ek dosya içeren kontrollü PDF;
- `mime-mismatch.exe`: PDF MIME beyanıyla gönderilen zararsız yürütülebilir örnek;
- `eicar.txt/pdf`: standart güvenli EICAR test dizisi;
- `duplicate-a` ve `duplicate-b`: farklı adla aynı byte dizisi;
- `orphan-object` ve `missing-object-row`: uzlaştırma için kontrollü kayıtlar;
- `integrity-mismatch`: test alanında kaydı ve nesnesi kontrollü farklılaştırılan örnek.

Sentetik dosyalar depo içinde tutulacaksa içeriklerinin SHA-256 değerleri ve
üretim betiği sürümlenir. Gerçek zararlı yazılım kullanılmaz.

## 5. S3 politikası §19 kabul sözleşmesi

### T-01 — Aynı anahtara ikinci yazma engellenir

- Ön koşul: F1.1 koşullu yazma adaptörü ve ayrı staging asıl alanı hazırdır.
- Veri/uygulama: Sentetik nesne benzersiz anahtara yazılır; farklı içerik aynı
  anahtara ikinci kez `putIfAbsent/promote` edilir.
- Beklenen: İkinci yazma sağlayıcı düzeyinde reddedilir; ilk nesnenin sürümü,
  boyutu ve SHA değeri değişmez.
- Kanıt: Maskelenmiş istek sonuçları, sağlayıcı hata eşlemesi, önce/sonra
  `head` ve tam SHA raporu.
- Yürüten: Yazılım Geliştirme.
- Onaylayan: Bilgi Güvenliği.
- Kod ön kanıtı: `tests/ingest-promotion.test.ts`; başarılı terfi, yazma sonrası
  yanıt kaybı/kurtarma, bozuk asıl ve mükerrer SHA senaryoları. Bu test gerçek
  sağlayıcı kanıtının yerine geçmez.

### T-02 — Asıl SHA yazma sonrası doğrulanır

- Ön koşul: F1.5 terfi ve akışlı yeniden okuma uygulanmıştır.
- Veri/uygulama: Bilinen SHA değerli sentetik PDF karantinadan terfi ettirilir.
- Beklenen: Karantina SHA, kabul alındısı, asıl tam okuma SHA ve veritabanı SHA
  değerleri aynıdır; uyuşmazlıkta `ACCEPTED` oluşmaz.
- Kanıt: Değiştirilemez `promotion_receipts` kaydı, tarama alındısı, karantina
  nesne kaydı, `binary_objects` kaydı, tam yeniden okuma SHA sonucu ve negatif
  uyuşmazlık koşusu.
- Yürüten: Yazılım Geliştirme.
- Onaylayan: Bilgi Güvenliği ve Arşiv.

### T-03 — Asıl değişmeden türev üretilir

- Ön koşul: ADR-015 renderer ve F1.7 türev kaydı hazırdır.
- Veri/uygulama: Sentetik PDF'den erişim türevi, ardından ikinci profil sürümü
  üretilir.
- Beklenen: Yeni `binary_objects` kayıtları oluşur; asıl anahtar, sürüm ve SHA
  değişmez.
- Kanıt: Önce/sonra asıl envanteri, `derived_from_id`, renderer/profil sürümü ve
  türev SHA değerleri.
- Yürüten: Yazılım Geliştirme.
- Onaylayan: Arşiv ve Bilgi Güvenliği.

### T-04 — Kullanıcı bucket anahtarı alamaz

- Ön koşul: F1.9 görüntüleme ve indirme akışları hazırdır.
- Veri/uygulama: Normal kullanıcıyla yükleme, görüntüleme ve indirme istekleri
  çalıştırılır; yanıt başlık/gövde ve tarayıcı ağ izi taranır.
- Beklenen: S3/R2 erişim anahtarı, gizli anahtar, bucket adı veya yeniden
  kullanılabilir sağlayıcı belirteci kullanıcıya dönmez.
- Kanıt: Maskelenmiş HTTP/ağ izi, secret tarama sonucu ve IAM politika özeti.
- Yürüten: Kalite Güvence.
- Onaylayan: Bilgi Güvenliği.

### T-05 — Süresi dolan görüntüleme bileti çalışmaz

- Ön koşul: ADR-015 türevi ve F1.9 bilet servisi hazırdır.
- Veri/uygulama: 60 saniyelik tek kullanımlık değişim bileti üretilir; süre
  dolmadan, tekrar kullanımda ve süre dolduktan sonra denenir.
- Beklenen: İlk yetkili değişim başarılı; tekrar ve süre sonrası kullanım sabit
  yetki hatasıyla reddedilir. Oluşmuş görüntüleme oturumu başka belgeye taşınamaz.
- Kanıt: Kontrollü saatli test, bilet özeti kaydı ve denetim olayları.
- Yürüten: Kalite Güvence.
- Onaylayan: Bilgi Güvenliği.

### T-06 — Yetkisiz rol aslı okuyamaz veya silemez

- Ön koşul: ADR-014 fiziksel rol ayrımı ve ADR-016 asıl kasa politikası uygulanmıştır.
- Veri/uygulama: Viewer, normal uygulama, tarama ve OCR rolleriyle asıl `get`,
  `delete` ve overwrite denenir.
- Beklenen: Tanımsız işlemlerin tamamı uygulama ve depolama düzeyinde reddedilir.
- Kanıt: Negatif IAM testleri, rol/politika özeti ve değişmeyen asıl SHA.
- Yürüten: Bilgi Güvenliği.
- Onaylayan: Bilgi İşlem yöneticisi.

### T-07 — Sürümleme/Object Lock ve yasal bekletme

- Ön koşul: ADR-016 ve test sağlayıcısının seçili değişmezlik profili hazırdır.
- Veri/uygulama: Retention altındaki nesne üzerinde overwrite/delete; legal hold
  açık ve kapalı durumları; süre uzatma ve kısaltma denenir.
- Beklenen üretim profili: Silme/overwrite ve süre kısaltma reddedilir; uzatma
  yetkili rolle çalışır; legal hold tasfiyeyi durdurur.
- R2 pilot sonucu: Object Lock/legal hold `NOT_APPLICABLE`; ayrı bucket lock
  silme/overwrite testi `PASS` olmalıdır.
- Kanıt: ADR kimliği, sağlayıcı yapılandırma özeti, negatif/pozitif işlem
  sonuçları ve değişmeyen SHA/sürüm.
- Yürüten: Depolama İşletimi ve Bilgi Güvenliği.
- Onaylayan: Arşiv, Hukuk/KVKK ve Bilgi İşlem yöneticisi.

### T-08 — Bütünlük taraması uyuşmazlığı yakalar

- Ön koşul: F1.6 kalıcı tarama koşusu, bulgu ve alarm yolu hazırdır.
- Veri/uygulama: Ayrı test adaptöründe metadata aynı bırakılarak kontrollü içerik
  uyuşmazlığı oluşturulur.
- Beklenen: Tam akış SHA taraması uyuşmazlığı bulur, kalıcı bulgu ve alarm
  üretir; geçici sağlayıcı kesintisini bozulma saymaz ve otomatik sessiz onarım
  yapmaz.
- Kanıt: `integrity_run`, `integrity_finding`, bulgu kimliğiyle aynı alarm
  korelasyon kimliği, sabit kapsam su işareti ve işletim teyidi.
- Yürüten: Kalite Güvence.
- Onaylayan: Bilgi Güvenliği ve Depolama İşletimi.

### T-09 — Belge bağlamıyla yedekten geri yüklenir

- Ön koşul: ADR-017 yedek ve izole geri yükleme alanı hazırdır.
- Veri/uygulama: Seçili sentetik belge üst veri, ilişkiler, türev ve denetim
  bölümüyle geri yüklenir.
- Beklenen: Nesne SHA değerleri eşleşir; belge uygulama adaptörüyle okunur; elde
  edilen RPO/RTO hedef içindedir.
- Kanıt: Geri yükleme raporu, manifest özeti, ilişki sayımları ve süreler.
- Yürüten: Yedekleme/Depolama İşletimi.
- Onaylayan: Arşiv ve Bilgi İşlem yöneticisi.

### T-10 — Sağlayıcı taşınabilirlik manifesti doğrulanır

- Ön koşul: F1.10 taşınabilir paket ve ikinci S3 uyumlu test hedefi hazırdır.
- Veri/uygulama: Paket kaynak sağlayıcıdan dışa aktarılıp ikinci adaptörle hedefe
  yüklenir.
- Beklenen: Bütün nesne boyutları ve SHA-256 değerleri eksiksiz eşleşir; sağlayıcı
  ETag/sürüm kimliği bütünlük kararı için kullanılmaz.
- Kanıt: Kaynak/hedef manifestleri, doğrulama özeti ve adaptör sürümleri.
- Yürüten: Depolama İşletimi.
- Onaylayan: Bilgi Güvenliği ve Arşiv.

### T-11 — Anahtar ve erişim logunda kişisel veri yoktur

- Ön koşul: F1.8 eski anahtar taşıması ve yapılandırılmış log politikası tamamlanmıştır.
- Veri/uygulama: Adres, ada/parsel, kişi adı ve T.C. kimlik biçimi içeren sentetik
  üst veriyle uçtan uca koşu yapılır; nesne anahtarı, custom metadata ve loglar
  desen/sözlük taramasından geçirilir.
- Beklenen: Hassas değerler bu alanlarda bulunmaz; kullanıcı dosya adı nesne
  anahtarı değildir.
- Kanıt: Maskelenmiş tarama raporu, taşınan eski nesne sayımı ve sıfır açık bulgu.
- Yürüten: Kalite Güvence ve Veri Koruma sorumlusu.
- Onaylayan: Hukuk/KVKK ve Bilgi Güvenliği.

### T-12 — İki yönlü uzlaştırma rapor üretir

- Ön koşul: F1.6 depo envanteri ve veritabanı uzlaştırması hazırdır.
- Veri/uygulama: Bir sahipsiz nesne ve bir dosyasız kayıt kontrollü oluşturulur.
- Beklenen: İki ayrı kalıcı bulgu doğru sınıf ve nesne/kayıt kimliğiyle oluşur;
  genç nesne yaş toleransında yanlış alarm olmaz; normal uygulama aslı otomatik
  silmez.
- Kanıt: `reconciliation_run`, iki bulgu, kapsam su işaretleri, sayımlar ve yetkili çözüm durumları.
- Yürüten: Kalite Güvence.
- Onaylayan: Depolama İşletimi ve Arşiv.

## 6. Kabul hattı güvenlik testleri

| No | Ön koşul ve veri | Beklenen sonuç | Yürüten | Onaylayan |
|---:|---|---|---|---|
| K-1 | PDF MIME beyanlı zararsız yürütülebilir örnek | `TYPE_MISMATCH`; asıl/OCR yok | Kalite Güvence | Bilgi Güvenliği |
| K-2 | Güncel motorla EICAR örneği | `MALWARE_DETECTED`; karantinada red; motor/imza sürümü kayıtlı | Kalite Güvence | Bilgi Güvenliği |
| K-3 | Multipart ortasında ağ kesintisi | Eksik parçadan sürer; ikinci asıl yok | Kalite Güvence | Yazılım Geliştirme |
| K-4 | Viewer rolüyle karantina okuma | Uygulama ve depolama düzeyinde red | Bilgi Güvenliği | Bilgi İşlem yöneticisi |
| K-5 | Asıl terfiden sonra DB sonlandırma hatası | Asıl silinmez; sahipsiz nesne bulgusu oluşur | Kalite Güvence | Arşiv |
| K-6 | 2 GiB profil; oturum başına dört eşzamanlı parça ve en az dört eşzamanlı oturum | Bellek dosya boyutuyla ve oturum sayısıyla doğrusal artmaz; çalışma zamanı sınırı güvenli baş boşluğuyla aşılmaz | Performans/Kalite Güvence | Bilgi İşlem |
| K-7 | Aynı byte dizisi, farklı ad ve sahte istemci SHA | Sunucu SHA ile `DUPLICATE`; yeni belge/asıl/OCR yok; bilgi sızıntısı yok | Kalite Güvence | Bilgi Güvenliği |

Her K testi için korelasyon kimliği, durum geçişleri, nesne/veritabanı sayımları
ve ilgili negatif erişim sonucu manifestte yer alır.

## 7. Kanıt paketine girmeyecek veriler

- gerçek belge içeriği veya özgün dosya adı;
- kişi adı, T.C. kimlik numarası, açık adres ya da ada/parsel değeri;
- açık erişim bileti, oturum çerezi, bucket anahtarı, token veya secret;
- maskelenmemiş IAM/sağlayıcı kimliği;
- hassas HTTP gövdesi veya tarayıcı ağ kaydı.

Kanıt, ham içerik yerine nesne kimliği, sınıf, byte boyutu, SHA-256, hata kodu,
zaman ve maskelenmiş politika sonucunu kullanır.

## 8. Çıkış ve imza

Faz 1 çıkışında:

- 12 politika testi sonuçlandırılmış ve uygulanabilir olanların tamamı `PASS`;
- K-1…K-7 sonuçları `PASS`;
- Faz 0 staging uçtan uca kanıtı `PASS`;
- açık kritik/yüksek güvenlik veya bütünlük bulgusu sıfır;
- Bilgi İşlem, Bilgi Güvenliği ve Arşiv onayı;
- Test 7, saklama veya kişisel veri kapsamı için gerektiğinde Hukuk/KVKK onayı

zorunludur. Onay kişi adı yerine kurumsal kimlik, rol, zaman ve imza/kanıt
özetiyle kaydedilir.

