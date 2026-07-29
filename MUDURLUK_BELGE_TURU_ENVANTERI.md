# Sivas Belediyesi Dijital Arşiv — Müdürlük ve Belge Türü Envanteri

**Belge durumu:** Keşif ve kurum görüşmesi taslağı  
**Sürüm:** 0.1  
**Tarih:** 29 Temmuz 2026  
**Kapsam:** Müdürlüklerin belge türleri, ortak varlıkları, özel alanları ve pilot adayları

> Bu dosyadaki müdürlük ve belge türleri başlangıç hipotezidir; resmî ve eksiksiz kurum envanteri değildir. Her satır ilgili müdürlük, arşiv birimi ve hukuk/KVKK tarafından doğrulanmalıdır.

## 1. Amaç

Bu envanter, her müdürlüğün kendine özgü belge yapısını ortak arşiv çekirdeğine bağlamak için kullanılır. Amaç bütün müdürlükleri aynı forma zorlamak değil; ortak alanları merkezileştirirken belge türüne özgü alanları sürümlü profillerle yönetmektir.

## 2. Envanter çalışma yöntemi

Her müdürlük için aşağıdaki çalışma yapılır:

1. Müdürlükte belge üreten ve kullanan roller belirlenir.
2. Aktif ve tarihsel belge türleri listelenir.
3. Belgenin geliş kanalı, hacmi, biçimi ve fiziksel durumu kaydedilir.
4. Aramada kullanılan gerçek ipuçları gözlemlenir.
5. Ortak varlıklar ve müdürlüğe özgü alanlar ayrılır.
6. Dosya planı, saklama ve erişim sınıfı yetkili kaynakla eşleştirilir.
7. OCR kritik alanları ve insan onayı kuralları belirlenir.
8. EBYS, CBS veya müdürlük uygulaması bağlantıları kaydedilir.
9. Temsilî belge örnekleri kişisel veri ve yetki kurallarıyla pilot sete alınır.
10. Müdürlük veri sorumlusu envanteri onaylar.

## 3. Durum kodları

| Durum | Anlam |
|---|---|
| `HYPOTHESIS` | Görüşme öncesi başlangıç önerisi |
| `DISCOVERED` | Kullanıcı görüşmesi veya örnek belgede gözlendi |
| `VALIDATED` | Müdürlük ve arşiv birimi doğruladı |
| `PILOT` | Pilot kapsamına alındı |
| `ACTIVE` | Üretimde kullanılan profil |
| `RETIRED` | Yeni kayıtta kullanılmayan tarihsel profil |

Bu dosyadaki başlangıç kayıtlarının varsayılan durumu `HYPOTHESIS` değeridir.

## 4. Ortak belge alanları

Bütün belge türlerinde mümkün olduğunca şu çekirdek kullanılır:

- Arşiv referans numarası
- Kaynak sistem ve kaynak kayıt kimliği
- Belge türü ve profil sürümü
- Sorumlu müdürlük
- Belge tarihi ve sayısı
- Konu
- Dosya planı kodu ve saklama kuralı
- Erişim/veri sınıfı
- Asıl dosya, SHA-256 ve nesne kaydı
- İş akışı durumu
- Oluşturan/yükleyen aktör
- Denetim olayları

Adres, parsel, yapı, bağımsız bölüm, kişi ve kurum bilgileri düz metin alanlardan çok ortak varlık ilişkileri olarak modellenir.

## 5. Başlangıç müdürlük-belge türü matrisi

| Müdürlük | Belge türü adayı | Ortak varlıklar | Özel alan adayları | OCR kritik alanları | Entegrasyon | Durum |
|---|---|---|---|---|---|---|
| İmar ve Şehircilik | İmar durumu belgesi | Parsel, adres, plan | Plan adı, plan ölçeği, kullanım kararı, yapılaşma koşulu | Ada, parsel, belge tarihi, plan kararı | CBS/Kent Rehberi, EBYS | `HYPOTHESIS` |
| İmar ve Şehircilik | Numarataj tespit tutanağı | Adres, yapı, parsel | Eski/yeni kapı no, yol adı, tespit tarihi | Adres, kapı no, parsel | CBS/Kent Rehberi | `HYPOTHESIS` |
| İmar ve Şehircilik | Yapı ruhsatı | Yapı, parsel, adres, kişi/kurum | Ruhsat no, yapı sınıfı, kullanım amacı, bağımsız bölüm sayısı | Ruhsat no, tarih, parsel | CBS, EBYS, ruhsat uygulaması | `HYPOTHESIS` |
| İmar ve Şehircilik | Yapı kullanma izin belgesi | Yapı, parsel, adres, kişi/kurum | İzin no, ruhsat bağı, kullanım türü | İzin no, tarih, parsel | CBS, EBYS, ruhsat uygulaması | `HYPOTHESIS` |
| Yazı İşleri | Encümen kararı | Parsel, adres, kişi/kurum | Karar no, toplantı tarihi, karar konusu, ilgili birim | Karar no, tarih, ana parseller | EBYS, karar sistemi | `HYPOTHESIS` |
| Yazı İşleri | Meclis kararı | Plan, parsel, kurum | Karar no, birleşim, gündem, komisyon | Karar no, tarih, konu | EBYS, karar sistemi | `HYPOTHESIS` |
| Emlak ve İstimlak | Emlak beyan belgesi | Parsel, adres, kişi/kurum | Sicil no, beyan türü, hisse, kullanım | Sicil, parsel, tarih | Emlak uygulaması, CBS | `HYPOTHESIS` |
| Emlak ve İstimlak | Kamulaştırma dosyası belgesi | Parsel, kişi/kurum, proje | Kamulaştırma türü, karar, bedel süreci | Parsel, karar no, tarih | CBS, hukuk, EBYS | `HYPOTHESIS` |
| Emlak ve İstimlak | Tahsis/kira belgesi | Taşınmaz, kişi/kurum | Sözleşme no, süre, kullanım amacı | Taşınmaz, tarih, taraf | Emlak uygulaması | `HYPOTHESIS` |
| Yapı Kontrol | Yapı tatil zaptı | Yapı, parsel, adres, kişi/kurum | Tespit, aykırılık türü, mühür bilgisi | Parsel, adres, tarih | CBS, EBYS | `HYPOTHESIS` |
| Yapı Kontrol | Yıkım kararı/tespit belgesi | Yapı, parsel, adres | Karar no, risk/aykırılık, uygulama durumu | Yapı/parsel, karar, tarih | CBS, EBYS | `HYPOTHESIS` |
| Ruhsat ve Denetim | İşyeri açma ve çalışma ruhsatı | Adres, yapı, bağımsız bölüm, kişi/kurum | Ruhsat no, faaliyet kodu, işyeri unvanı | Ruhsat no, adres, tarih | Ruhsat uygulaması, CBS | `HYPOTHESIS` |
| Ruhsat ve Denetim | Ruhsat denetim tutanağı | Adres, işyeri, kişi/kurum | Denetim türü, sonuç, eksiklik | Adres, ruhsat no, tarih | Ruhsat uygulaması | `HYPOTHESIS` |
| Zabıta | Tespit/denetim tutanağı | Adres, işyeri, kişi/kurum | Tutanak türü, ihlal, işlem sonucu | Adres, tarih, işletme | Zabıta uygulaması, CBS | `HYPOTHESIS` |
| Fen İşleri | İş emri/hakediş eki | Yol, adres, proje, yüklenici | İş emri no, proje no, imalat türü | Yer, iş emri, tarih | CBS, proje sistemi | `HYPOTHESIS` |
| Fen İşleri | Yol ve altyapı çalışması belgesi | Yol, geometri, adres, proje | Başlangıç/bitiş, iş türü, güzergâh | Yol, tarih, proje | CBS/Kent Rehberi | `HYPOTHESIS` |
| İtfaiye | Yangın güvenlik raporu | Adres, yapı, işyeri, kişi/kurum | Rapor no, kullanım sınıfı, sonuç, eksiklik | Rapor no, adres, tarih | CBS, ruhsat uygulaması | `HYPOTHESIS` |
| İtfaiye | Olay raporu | Adres, yapı, kişi/kurum | Olay türü, ihbar/varış zamanı, sonuç | Adres, zaman, olay türü | Acil durum sistemi, CBS | `HYPOTHESIS` |
| Hukuk İşleri | Dava/uyuşmazlık belgesi | Kişi/kurum, parsel, sözleşme | Dosya no, mahkeme, konu, durum | Dosya no, taraf, tarih | Hukuk uygulaması, EBYS | `HYPOTHESIS` |

## 6. Önerilen ilk pilot

Kent Rehberi ve ada-parsel değerini erken doğrulamak için başlangıç pilot adayı:

**Pilot müdürlük adayı:** İmar ve Şehircilik Müdürlüğü  
**Pilot belge türü adayları:**

1. İmar durumu belgesi
2. Numarataj tespit tutanağı
3. Yapı ruhsatı
4. Yapı kullanma izin belgesi

**Pilot destek belgesi:** Parsel içeren seçili Encümen kararları, Yazı İşleri sahipliği korunarak çapraz müdürlük ilişki testi için kullanılabilir.

Bu önerinin gerekçeleri:

- Adres, parsel ve yapı ilişkilerini birlikte sınar.
- Kent Rehberi entegrasyonuna doğrudan iş değeri sağlar.
- Bir belgede birden fazla parsel ve tarihsel adres örnekleri bulunabilir.
- OCR kritik alan ölçümü somuttur.
- Başka müdürlüklere aktarılabilir ortak varlık çekirdeğini test eder.

Pilot seçimi kurum onayı olmadan kesinleşmiş sayılmaz.

## 7. Belge türü inceleme formu

Her belge türü için aşağıdaki form doldurulur:

| Başlık | Cevap |
|---|---|
| Müdürlük |  |
| Belge türü |  |
| İş amacı |  |
| Kurumsal veri sahibi |  |
| Üreten sistem/rol |  |
| Belge geliş kanalı |  |
| Yıllık belge/sayfa hacmi |  |
| Tarih aralığı |  |
| Fiziksel/dijital biçimler |  |
| Tarama kalite sorunları |  |
| Aramada kullanılan alanlar |  |
| Ortak varlıklar |  |
| Müdürlük özel alanları |  |
| Çoklu değer alanları |  |
| Kritik alanlar |  |
| İnsan onayı koşulları |  |
| Dosya planı kodu/kaynağı |  |
| Saklama kuralı/kaynağı |  |
| Erişim ve veri sınıfı |  |
| EBYS/CBS/diğer entegrasyon |  |
| Temsilî örnek sayısı |  |
| Bilinen istisnalar |  |
| Onaylayan ve tarih |  |

## 8. Müdürlük görüşmesinde sorulacak sorular

1. En sık üretilen veya aranan beş belge türü hangileridir?
2. Belgeyi bulmak için gerçekte hangi alanlar kullanılıyor?
3. Bir belge hangi noktada resmî veya tamamlanmış kabul ediliyor?
4. Hangi alanın yanlış olması en yüksek iş/hukuk riskini doğurur?
5. Belge birden fazla adres, parsel, kişi veya yapıyla ilişkili olabilir mi?
6. Eski adres veya parsel değişiklikleri nasıl takip ediliyor?
7. Belgenin kimler tarafından görülmemesi gerekir?
8. Hangi sistemlerde aynı belgenin veya kaydın başka kopyaları bulunuyor?
9. Dosya planı ve saklama kararı kim tarafından veriliyor?
10. Personel bir belgeyi bulamadığında hangi alternatif yola başvuruyor?
11. Hangi belgeler toplu, düşük kaliteli veya el yazılıdır?
12. Başarılı pilot müdürlük açısından neyi ölçmelidir?

## 9. Profil onay koşulları

Bir belge türü `VALIDATED` olmadan önce:

- Kurumsal sahibi belirlenmiş olmalı.
- Zorunlu, koşullu ve çoklu alanlar onaylanmış olmalı.
- Ortak varlık ilişkileri tanımlanmış olmalı.
- Kritik alan ve insan onayı politikası belirlenmiş olmalı.
- Veri sınıfı ve erişim sınırı onaylanmış olmalı.
- Dosya planı ve saklama kaynağı belirlenmiş olmalı.
- Temsilî belge örnekleriyle OCR/arama denemesi yapılmış olmalı.
- Entegrasyon kimlikleri ve kaynak sistem sorumluları kaydedilmiş olmalı.

## 10. Envanter çıktıları

Tamamlanan envanter aşağıdaki teknik çıktılara dönüşür:

- `VERI_SOZLUGU.md` alan ve sözlük güncellemeleri
- Belge türü profil tanımları
- OCR alan şemaları ve kritik alan politikaları
- Arama filtreleri ve varlık ilişki türleri
- Yetki matrisi
- Dosya/saklama planı eşlemeleri
- Pilot veri seti ve kabul ölçütleri
- API ve entegrasyon sözleşmeleri

