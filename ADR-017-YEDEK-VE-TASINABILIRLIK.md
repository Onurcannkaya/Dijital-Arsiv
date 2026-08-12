# ADR-017 — Yedek, RPO/RTO ve Sağlayıcı Taşınabilirliği

- Durum: Üretim hedefi olarak kurumsal onaylandı (ADR-018, 2026-08-12)
- Tarih: 2026-07-30
- Kapsam: Üst veri, asıl/türev nesneler, denetim izi ve geri yükleme
- Sahip: Bilgi İşlem
- Gerekli kurumsal onaylar: Bilgi İşlem, Bilgi Güvenliği, Arşiv

## Bağlam

Nesne deposundaki çoğaltma tek başına yedek değildir. Dosya geri gelse bile üst
veri, belge ilişkileri, yetki, türev bağlantıları ve denetim izi olmadan arşiv
bağlamı geri kazanılmış sayılmaz. Sağlayıcı ETag veya sürüm kimliği de başka
sağlayıcıda doğrulanabilir bütünlük kanıtı değildir.

## Karar

### Pilot hizmet hedefleri

| Veri/hizmet sınıfı | RPO | RTO | Yöntem |
|---|---:|---:|---|
| Belge üst verisi, yetki ve denetim | En çok 15 dakika | En çok 4 saat | Noktadan geri dönüş/PITR veya eşdeğer günlükleme, günlük bağımsız dışa aktarım |
| Kabul edilmiş asıl nesneler | En çok 1 saat | En çok 8 saat | İkinci hata alanına artımlı kopya, günlük bağımsız manifest |
| OCR ve erişim türevleri | En çok 24 saat | En çok 24 saat | Yedek veya doğrulanmış asıldan idempotent yeniden üretim |
| Arama dizini ve geçici kuyruk görünümü | Kalıcı veri sayılmaz | En çok 24 saat | Yetkili kayıtlardan yeniden kurulum |

Bu değerler Faz 1 pilot kabul hedefidir. Gerçek hacim ve belediyenin iş etki
analizi daha sıkı hedef gerektirirse yeni ADR sürümüyle düşürülür; sessizce
gevşetilemez.

Bir belge kullanıcıya `ACCEPTED` dönmeden önce birincil asıl yazma ve tam SHA
doğrulaması tamamlanır. Yukarıdaki asıl RPO değeri birincil hata alanının tümden
kaybı içindir; yarım kabulü başarılı gösterme yetkisi vermez.

### Yedek profili

- Üst veri için 15 dakikayı aşmayan geri dönüş noktası ve günlük şifreli bağımsız
  dışa aktarım tutulur.
- Kabul edilmiş asıllar en geç saatte bir ikinci hata alanına artımlı aktarılır.
- Günde en az bir kez nesne ve üst veri için aynı kesim zamanını ilişkilendiren
  manifest üretilir.
- En az bir yedek kopyası farklı yönetim kimliği ve farklı hata alanındadır.
- Yedek anahtarları üretim uygulama kimliğinden ayrıdır.
- Yedek saklama süresi ve anahtar sahipliği kurumsal saklama planıyla onaylanır;
  bu ADR belge türü saklama süresi belirlemez.

### Taşınabilir paket

Sağlayıcıdan bağımsız paket en az şunları taşır:

- paket ve şema sürümü;
- mantıksal belge ve nesne kimlikleri;
- nesne sınıfı, medya türü, byte boyutu ve SHA-256;
- belge üst verisi ve profil sürümü;
- doğrulanmış varlık ilişkileri;
- türev ve `derived_from_id` ilişkileri;
- doğrulama için gereken denetim zinciri bölümü;
- saklama ve legal hold durumunun taşınabilir gösterimi.

Sağlayıcı anahtarı, ETag ve sürüm kimliği yardımcı kaynak alanlarıdır; taşınabilir
bütünlük kanıtı değildir. Manifest kanonik JSON olarak üretilir, SHA-256 özeti ve
kurumsal imza/anahtar kimliğiyle doğrulanır.

## Tatbikat

- Aylık: yedek işi ve manifest tutarlılığı otomatik kontrolü.
- Üç ayda bir: seçili belgeyi üst veri, ilişkiler, türev ve denetim iziyle ayrı
  geri yükleme alanına alma.
- Altı ayda bir: paketleri farklı bir S3 uyumlu test hedefine taşıma ve uygulama
  adaptörüyle okuma.
- Yılda bir: birincil sağlayıcı erişilemez kabul edilerek süreli felaket kurtarma
  tatbikatı.

Tatbikat üretim verisini gereksiz çoğaltmaz. Seçili kayıt açık yetkiyle alınır
veya sentetik veri kullanılır. Başlangıç/bitiş zamanı, elde edilen RPO/RTO,
manifest sonucu, hata ve düzeltici faaliyet kanıt paketine girer.

## Başarısızlık ve geri dönüş

RPO/RTO aşıldığında test başarılı sayılmaz. İstisna kaydı otomatik geçiş
sağlamaz; düzeltici faaliyet, sorumlu ve son tarih gerekir. Geri yüklenen veri
doğrudan üretimin üzerine yazılmaz; izole alanda SHA, ilişki ve denetim
doğrulamasından sonra yetkili geçiş yapılır.

## Sonuçlar

- Geri kazanım dosya kopyalamaktan çıkar, belge bağlamını kapsar.
- İkinci hata alanı ve sık manifest üretimi maliyet getirir.
- Sağlayıcı değişimi düzenli tatbikatla ölçülebilir hâle gelir.
- Kurumsal saklama ve yedek silme süreleri ayrıca onaylanmadan üretime geçilemez.

## Doğrulama

- Seçili belge tüm bağlamıyla RTO içinde ayrı alana geri yüklenir.
- Her nesnenin SHA değeri manifestle eşleşir.
- Paket ikinci S3 uyumlu adaptörle okunur.
- Gerçekleşen RPO/RTO hedefle birlikte raporlanır.
- Üretim ve yedek kimliklerinin görev ayrılığı negatif IAM testiyle gösterilir.

