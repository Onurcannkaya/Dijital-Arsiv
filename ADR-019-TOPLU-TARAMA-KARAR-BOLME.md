# ADR-019 — Toplu Tarama Dosyalarının Karar Birimine Bölünmesi

- Durum: **TASLAK — teknik karar verilmedi, kurumsal karar bekliyor**
- Tarih: 2026-08-18
- Kapsam: Bir dosyada yüzlerce karar taşıyan toplu tarama PDF'leri; belge
  kaydının birimi; karar bazlı arama, doğrulama, dosya planı ve saklama
- Sahip: Bilgi İşlem (taslak) — karar sahipleri aşağıda
- Gerekli kurumsal onaylar: Arşiv birimi, Yazı İşleri Müdürlüğü, Hukuk/KVKK,
  Bilgi İşlem

## Bağlam

Kurumun elindeki tarama dosyaları **belge başına değil, cilt başına**
üretilmiş. `D:\Arşiv` ölçümü (2026-08-18):

| Dosya | Sayfa | Boyut | Dosya adının iddia ettiği aralık |
|---|---:|---:|---|
| Encümen Asıl / 1975 - 1 - 600 | 623 | 389,2 MB | 1–600 karar |
| Encümen Asıl / 2021 1 - 75 | 459 | 241,7 MB | 1–75 karar |
| Encümen Asıl / 2021 1580 - 1635 | 397 | 71,1 MB | 1580–1635 karar |
| Encümen Suret / 1983 | 1640 | 909,3 MB | yıl geneli |
| Encümen Suret / 2019 1 - 1632 | 1646 | 303,8 MB | 1–1632 karar |
| Encümen Suret / 2020 1 - 1716 | 1749 | 863,4 MB | 1–1716 karar |
| Meclis / 1972 | 337 | 221,1 MB | yıl geneli |
| Meclis / 2021 1 - 30 | 178 | 83,9 MB | 1–30 karar |
| **Toplam** | **7.029** | **3,01 GiB** | |

Uygulamanın belge kaydı ise **bir yükleme = bir `archive_documents` satırı**
(`lib/ingest-promotion.ts`). Sayfa aralığına bölme adımı yoktur. Bunun iki
somut sonucu ölçüldü:

1. **Tek değerli alanlar sessizce yanlış oluyor.** Belge tarihi, belge türü ve
   müdürlük tek değerlidir; belge kapanışında en yüksek güvenli tek aday seçilir
   (`app/api/jobs/process/route.ts`). 1.632 kararlı bir dosyada tek bir belge
   tarihi seçilir, geri kalan 1.631 kararın tarihi düşer. Hata vermeyen ama
   yanlış veri üreten yol budur ve zaman aşımından daha tehlikelidir.
2. **Karar numarası belge düzeyinde anlamsız.** Yeni eklenen `document_number`
   alanı 1975 dosyasının 17–21. sayfalarında 442, 419, 351 ve 307 değerlerini
   doğru çıkardı — dördü de ayrı kararlara ait. "Belgenin karar numarası" diye
   tek bir değer, 487 kararlı bir dosyada tanımsızdır.

Buna ek olarak dosya planı ve saklama kuralı **karar başına** uygulanır: bir
ciltteki kararlar farklı saklama sürelerine tabi olabilir. Cilt tek belge
kaldığı sürece kurum, en uzun süreyi bütün cilde uygulamak zorunda kalır.

### Neden basit bir "böl" adımı yeterli değil

**Sınır tespiti güvenilir değil ve hata İKİ YÖNLÜ.** Gömülü metin katmanından
karar başlığı sayımı (aynı ölçüm):

| Dosya | Sayfa | Tespit edilen başlık | Dosya adına göre karar | Yön |
|---|---:|---:|---:|---|
| 2020 1 - 1716 Encümen Suret | 1749 | 1.252 | ~1.716 | eksik |
| 2019 1 - 1632 Encümen Suret | 1646 | 880 | ~1.632 | eksik |
| 1975 - 1 - 600 Encümen Asıl | 623 | 487 | ~600 | eksik |
| 1983 Encümen Suret | 1640 | 131 | yıl geneli | çok eksik |
| 1972 Meclis | 337 | 11 | yıl geneli | çok eksik |
| 2021 1 - 30 Meclis Kararı | 178 | 61 | 30 | **fazla** |
| 2021 1580 - 1635 Encümen Asıl | 397 | 32 | 56 | eksik |

Eski daktilo taramalarında gömülü metin katmanı kullanılamaz durumdadır, bu
yüzden tespit çöküyor. 2021 Meclis dosyasında ise başlık devam sayfalarında da
tekrar ettiği için **iki katı** sınır bulunuyor. Yani ne "eksik böler" ne "fazla
böler" varsayımı yapılabilir.

**Gerçek OCR metniyle tespit daha iyi olacaktır ama ölçülmemiştir.** OCR
maliyeti sayfa başına ~50–65 sn (Windows CPU, ısınmış süreç): 623 sayfalık
dosya ≈ 8,6 saat, arşivin tamamı ≈ 98 saat. Yani **bölme ancak bütün sayfalar
okunduktan sonra** yapılabilir; bölme kararı OCR'ın önüne alınamaz.

**Yanlış bölünmüş bir karar, hiç bölünmemiş olandan daha zor onarılır.**
Bölünmemiş cilt eksik ama tutarlıdır: memur sayfayı bulur. Yanlış bölünmüş
kayıtta iki kararın alanları birbirine karışır, ayrı saklama kuralları yanlış
kayda bağlanır ve düzeltme iki kaydı birleştirip yeniden bölmeyi gerektirir.

### Değişmezlik kısıtı

ADR-016 aslı değişmez kılar. Şema bunu iki tekil indeksle uygular
(`lib/archive-schema.ts`):

- `binary_objects_single_original_unique` — belge başına **tek** `original`;
- `binary_objects_original_sha256_unique` — aynı asıl baytlar arşivde **bir kez**.

Dolayısıyla N kararın hepsi aynı cilt aslını `original` olarak gösteremez. Bölme
ya asıl olmayan bir nesne sınıfına dayanmak, ya da her karar için **yeni** asıl
baytlar üretmek zorundadır. İkincisi, taranmış olmayan bir nesneyi "asıl" diye
kaydeder ve ADR-016'nın köken anlamını boşaltır.

ADR-015 ise sayfa aralıklı türev bölümlerini zaten tanımlıyor: her bölüm kendi
`binary_objects` kaydı, `derived_from_id` bağı, sayfa aralığı ve SHA-256
değeriyle yazılıyor. Bölme için gereken nesne modeli parçası **vardır**; eksik
olan, karar kaydının bu bölümlere nasıl bağlanacağıdır.

## Karar verilecek noktalar

1. Karar birimi ayrı bir `archive_documents` kaydı mı olacak, yoksa cilt tek
   belge kalıp kararlar dizin kaydı mı olacak?
2. Karar kaydının nesnesi ne olacak: cilt aslına `derived_from_id` ile bağlı
   sayfa aralığı türevi mi, yeni asıl baytlar mı, hiç nesne yok mu?
3. Bölme otomatik mi uygulanacak, yoksa personel onayı gerektiren bir **öneri**
   mi olacak?
4. Otomatik uygulama için asgari doğruluk kapısı ne olacak ve nasıl ölçülecek?
5. Mevcut sekiz cilt geri dolumla mı bölünecek, yoksa yalnız bundan sonraki
   taramalar karar başına mı üretilecek?

## Seçenekler

### A — Karar dizini (cilt tek belge kalır)

Yeni tablo: `document_decisions` (`document_id`, `decision_no`, `page_from`,
`page_to`, `decision_date`, `verification_status`, kanıt). Cilt tek belge kalır;
arama karar numarasıyla dizine düşer ve sayfa aralığını açar.

- **Artı:** Nesne modeline hiç dokunmaz; ADR-015/016 tartışması açılmaz. Yanlış
  sınır yalnız üst veriyi bozar, düzeltmesi bir satır güncellemesidir. Bugün
  çalışan hattın üzerine eklenir.
- **Eksi:** Dosya planı ve saklama kuralı hâlâ cilt düzeyinde kalır — asıl
  arşivsel ihtiyaç karşılanmaz. Tek değerli alan sorunu yalnız kısmen çözülür:
  tarih ve numara dizinde karar başına tutulabilir ama `extracted_fields` hâlâ
  belge düzeyindedir.

### B — Mantıksal karar kaydı, sayfa aralığı türevine bağlı (önerilen hedef)

Her karar kendi `archive_documents` kaydı olur. Nesnesi, cilt aslından
türetilmiş **sayfa aralığı türevi**dir (ADR-015 bölüm deseni); `derived_from_id`
cildin aslını gösterir. Cilt aslı arşivin tek yetkili nesnesi olarak kalır ve
değişmez. Bunun için `object_class` kümesine asıl olmayan bir sınıf
(`excerpt`) eklenmesi ve "her belgenin bir `original` nesnesi vardır"
varsayımının gevşetilmesi gerekir.

- **Artı:** Dosya planı, saklama, doğrulama ve arama karar başına çalışır — asıl
  ihtiyaç budur. Alanlar doğru birimde toplanır; tek değerli alan sorunu kökten
  çözülür. Değişmezlik korunur: yeni asıl baytlar üretilmez.
- **Eksi:** En geniş değişiklik. Şema, kabul durum makinesi (ADR-013), bilet
  verme (ADR-015), bütünlük mutabakatı ve yedek/taşınabilirlik (ADR-017) kaydın
  "aslı yok" hâlini tanımak zorunda. Depolama, türev bölümleri kadar artar.

### C — Fiziksel bölme (her karar yeni asıl)

Her karar için yeni PDF üretilip `original` olarak kaydedilir; cilt kaynak
kayıt olarak saklanır.

- **Artı:** Mevcut şema hiç değişmez; her belge bugünkü gibi tek asıllıdır.
- **Eksi:** Taranmamış bir nesneyi "asıl" diye kaydeder ve ADR-016'nın köken
  anlamını boşaltır. Depolamayı ikiye katlar. Yanlış bölme, değişmez bir asıl
  ürettiği için düzeltilemez — yalnız tasfiye yetkisiyle geri alınabilir. **Bu
  seçenek önerilmiyor.**

### D — Bölme yok; kaynakta düzeltme

Bundan sonraki taramalar karar başına üretilir; mevcut sekiz cilt olduğu gibi
kalır ve yalnız tam metin aramasıyla bulunur.

- **Artı:** Sıfır kod. Yeni evrakta sorun hiç doğmaz.
- **Eksi:** Elde bulunan 7.029 sayfa karar bazında aranamaz ve saklama kuralı
  cilt düzeyinde kalır. Tek başına yeterli değildir ama **A veya B ile birlikte
  uygulanmalıdır**: yeni cilt üretmeyi sürdürmek, çözülen sorunu yeniden
  üretmek olur.

## Öneri (taslak)

**Aşamalı: D + A şimdi, B hedef.**

1. **D hemen:** Tarama talimatı karar başına dosya üretmeye çevrilir. Bu bir
   işletim kararıdır, kod gerektirmez ve sorunun büyümesini durdurur.
2. **A ilk aşama:** Karar dizini eklenir. Kararlar numarayla aranabilir hâle
   gelir, sınır tespiti gerçek OCR metni üzerinde **ölçülür** ve doğruluğu
   kanıtlanır — üst veri olduğu için hatası ucuzdur.
3. **B, kapı geçilirse:** Dizin doğruluğu kapıyı geçtiğinde karar kaydı
   modeline geçilir ve dizin, kayıtların üretim kaynağı olur.

**Bölme her aşamada ÖNERİDİR.** Sistemin bütün alan çıkarma davranışı zaten
"OCR önerir, personel doğrular" ilkesine dayanır (`extraction_policy`,
`verification_status`); sınır tespiti bundan daha güvenilir değildir, dolayısıyla
otomatik uygulanmamalıdır. Sınırlar `SUGGESTED` yazılır; memur onaylamadan
karar kaydı arşive girmez.

**Doğruluk kapısı (öneri):** Her belge türü ve dönem için insan onaylı bir
örnekte (en az 200 karar) sınır **kesinliği ≥ %99** ve **anması ≥ %95**
ölçülmeden hiçbir cilt otomatik bölünmez. Kapının altında kalan dönemlerde
kararlar yalnız öneri olarak listelenir. 1983 ve 1972 ciltlerinin bu kapıyı
gömülü metinle geçemediği şimdiden ölçülmüştür (131/1640 ve 11/337 başlık).

## Sonuçlar

- Bölme, değişmez asıl üzerinde **üst veri** olarak temsil edilir; yanlış sınır
  bir asıl nesne üretmediği için düzeltilebilir kalır.
- Karar bazlı saklama ve dosya planı ancak B ile mümkündür; A bunu vermez ve
  ara çözüm olduğu açıkça kaydedilmelidir.
- Her iki aşama da OCR'ın tamamlanmasına bağımlıdır (arşivin tamamı ≈ 98 saat
  tek makinede); bölme takvimi OCR takvimini takip eder.
- Tek değerli alanların cilt düzeyinde yanlış olması, B tamamlanana kadar
  **bilinen ve kabul edilen** bir sınırdır; arayüz bunu memura söylemelidir.

## Doğrulama

- İnsan onaylı örnekte sınır kesinliği ve anması ölçülür; kapı geçilmeden
  otomatik bölme açılmaz.
- Bir cildin bölünmesi cilt aslının SHA-256, sürüm ve anahtarını değiştirmez.
- Yanlış onaylanmış bir sınırın düzeltilmesi, asıl nesneye dokunmadan
  tamamlanabilir ve denetim kaydına yazılır.
- Aynı cilt için bölme işi ikinci kez koşturulduğunda ikinci kayıt kümesi
  oluşmaz (idempotans).
- Karar kaydı üzerinden verilen görüntüleme bileti yalnız o kararın sayfa
  aralığını açar; cildin tamamına erişim vermez.
- Bölünmüş kararların sayfa aralıkları bitişiktir, çakışmaz ve birleşimi cildin
  sayfa sayısını verir; boşluk kalırsa iş incelemeye düşer.
