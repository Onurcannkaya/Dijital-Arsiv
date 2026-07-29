# Diğer modeller için eşit koşullu geliştirme promptu

Aşağıdaki metni diğer modellere aynen verin. Her model **ayrı bir klasör, Git dalı veya worktree** üzerinde çalışmalı; aynı dosyaları eşzamanlı düzenletmeyin.

---

Sen kıdemli bir ürün mimarı, arşiv uzmanı, UX tasarımcısı ve full-stack geliştiricisin. Sivas Belediyesi için kurum içinde kullanılacak yapay zekâ destekli bir Dijital Arşiv PWA'sının ilk çalışan dikey dilimini geliştir.

## İncelenecek girdiler

1. Eski masaüstü uygulaması: https://github.com/Onurcannkaya/Evrak-yonetim-sistemi
2. Projedeki `Design.md` veya kullanıcı tarafından sağlanan itfaiye tasarım sistemi.
3. Bu çalışma klasöründeki mevcut dosyalar ve varsa `PROJE_PLANI.md`.

Eski uygulamayı dönüştürme veya satır satır taşıma. Onu yalnızca alan bilgisini anlamak için kullan: üç panelli belge inceleme, mahalle/ada/parsel/muhatap/müdürlük alanları, hızlı arama, toplu işleme ve GIS ilişkileri. Güvenlik ve mimari hatalarını kopyalama.

## Ürün hedefi

Doxagon benzeri anlaşılır ve sakin bir kurumsal arayüz oluştur; fakat belge işleme, alan bazlı güven, kanıt gösterimi, insan doğrulaması, arşiv bütünlüğü ve denetim izi açısından daha gelişmiş tasarla. Ürün ilk aşamada tam EBYS değil; mevcut EBYS ile entegre olabilecek dijital arşiv ve akıllı belge işleme katmanıdır.

## Teknoloji ve tasarım zorunlulukları

- Next.js 16, React, TypeScript ve Tailwind CSS 4.
- Masaüstü, tablet ve mobilde çalışan PWA; Türkçe arayüz.
- Tasarım tokenları kullan; sabit `gray/slate` sınıflarını bileşenlere dağıtma.
- Koyu sabit yan menü, açık ve sakin çalışma yüzeyi, kırmızı yalnızca Sivas kurumsal vurgu ve kritik eylemlerde.
- IBM Plex Sans / IBM Plex Mono veya eşdeğer okunaklı kurumsal yazı düzeni.
- Açık/koyu tema ve erişilebilir klavye/fokus durumları; WCAG 2.2 AA hedefi.
- Emoji ve dekoratif gösteriş kullanma. Karmaşık olmayan, yoğun veriyle çalışmaya uygun bir arayüz kur.
- Harici ücretli API veya API anahtarı kullanma. İlk dilimde örnek veriler yerel olabilir; bunu açıkça belirt.
- Kişisel veriyi `localStorage` içine kalıcı ürün verisi olarak yazma.

## Oluşturulacak çalışan ekranlar

1. Genel Bakış: gü

2. Gelen Evrak: arama, filtre, belge/OCR durumu ve kuyruğa ilişkin liste.
3. Dijital Arşiv: belge no, içerik, mahalle, ada/parsel, muhatap ve müdürlükle arama.
4. Belge Doğrulama: küçük sayfa görselleri, belge önizlemesi, çıkarılan alanlar, her alan için güven yüzdesi, düşük güven vurgusu ve doğrula/arşivle eylemi.
5. Responsive yan menü, tema değiştirme ve çalışan temel etkileşimler.

Gerçekçi örnek veri kullan: Sivas mahalleleri, belediye müdürlükleri, `1847 / 12-A` gibi ekleri koruyan ada/parsel değerleri ve kurumsal belge türleri. Kritik alanları sırf dolu oldukları için yüksek güvenli sayma.

## Mimari belgeler

Kodun yanında kısa bir mimari karar belgesi oluştur. Şunları anlat:

- Değiştirilemez asıl dosya + ayrı türevler ve SHA-256 bütünlük modeli.
- PostgreSQL üst veri, S3 uyumlu nesne depolama, kalıcı kuyruk ve arama dizini.
- Yerel OCR için PaddleOCR ana yol; düşük güvenli alanlarda yerel görsel-dil modeli yedeği.
- Her alan için değer, güven, sayfa, koordinat/kanıt metni, model sürümü ve insan düzeltmesi.
- Kurumsal kimlik, sunucu taraflı yetkilendirme, denetim izi ve saklama-imha akışı.
- TS 13298, Standart Dosya Planı, KVKK, Devlet Arşiv mevzuatı; ISO 15489, 23081, 14721, PDF/A ve WCAG uyumu.

## Kabul ölçütleri

- Proje bağımlılıkları kuruluyor ve üretim derlemesi hatasız tamamlanıyor.
- Ana akışlar yalnızca statik görsel değil; navigasyon, arama, belge açma ve tema gibi temel etkileşimler çalışıyor.
- Mobil görünüm kullanılabilir.
- TypeScript hatası, bozuk Türkçe karakter veya konsol hatası yok.
- Kod bileşenlere ayrılmış, erişilebilir adlar ve odak durumları var.
- Eski uygulamanın varsayılan parolaları, SHA-256 parola özeti, MD5 dosya özeti, sahte OCR güveni ve zorunlu Gemini bağımlılığı tekrarlanmıyor.

## Teslim biçimi

Önce mevcut dosyaları incele, sonra uygulamayı doğrudan geliştir. İş bitiminde:

1. oluşturduğun ekranları,
2. değiştirdiğin ana dosyaları,
3. çalıştırdığın doğrulamaları,
4. henüz örnek olan bölümleri,
5. sonraki en değerli dikey dilimi

kısa ve somut biçimde raporla. Açıklama yapmakla yetinme; çalışan kod üret ve derlemeyi doğrula.

---

## Karşılaştırma puan kartı

Her modeli 100 puan üzerinden aynı ölçütlerle değerlendirin:

- Ürün ve belediye iş akışını anlama: 15
- Arayüz kalitesi ve Design.md uyumu: 20
- Çalışan etkileşimler ve responsive davranış: 15
- Kod/mimari kalitesi: 15
- Arşiv standardı, bütünlük ve denetim yaklaşımı: 15
- OCR/AI güveni, kanıt ve insan doğrulaması: 15
- Derleme, erişilebilirlik ve teslim disiplini: 5
