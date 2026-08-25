# Sivas Belediyesi Dijital Arşiv

Sivas Belediyesi için geliştirilen yapay zekâ destekli dijital arşiv PWA'sının ilk çalışan ürün dilimidir.

## Bu sürümde

- Genel bakış ve belge işleme hattı
- Gelen evrak ve dijital arşiv listeleri
- Belge, muhatap, mahalle ve ada/parsel araması
- Alan bazlı güven gösteren belge doğrulama ekranı
- Açık/koyu tema ve responsive kurumsal arayüz
- PWA manifesti ve temel çevrimdışı kabuk
- PDF/görüntü yükleme, SHA-256 tekrar kontrolü ve değiştirilemez asıl dosya kasası
- Kalıcı belge üst verisi ve `paddleocr-local` işlem kuyruğu
- PaddleOCR 3.x/FastAPI yerel OCR servisi, alan çıkarımı ve tekrar deneme
- Sayfa metni, kelime kutuları, alan güveni ve kanıt koordinatlarının D1'e kaydı
- Seçilen gerçek asıl dosya üzerinde OCR kanıtı gösteren dinamik doğrulama ekranı
- Personel alan düzeltmesi/onayı ve kontrollü arşivleme akışı
- SHA-256 ile zincirlenen, güncelleme ve silmeye kapalı belge denetim izi
- Arşivlenen belgeler için sunucu taraflı salt okunur koruma
- Yönetici, arşiv yöneticisi, doğrulayıcı ve görüntüleyici rolleri
- Müdürlük kapsamlı belge listeleme, dosya erişimi ve işlem yetkileri
- Güvenilir kimlik başlığına bağlı sunucu taraflı yetkilendirme
- Bir belgede aynı alanın birden çok değeri: ada, parsel, mahalle ve muhatapta tek değer varsayımı yok
- Değer bazında doğrulama durumu (öneri / onaylı / düzeltildi / reddedildi) ve doğrulayan kaydı
- Model güveninden ayrı, biçim ve kritiklik değerlendiren risk seviyesi
- Asıl ve türev dosyalar için ayrı nesne kaydı (`binary_objects`)
- Parsel, adres ve yapı ortak varlıkları ile çoktan çoğa belge-varlık ilişkileri
- İlişki türü, kaynağı ve doğrulama durumu; OCR önerisi doğrulanmış ilişki sayılmaz
- İfraz/tevhit için parsel soy ilişkisi şeması
- Sürümlü ve doğrulanan şema göçü (`schema_state`)
- Sürümlü belge türü profilleri ve alan tanımları: alan kuralları kodda değil veritabanında
- Kontrollü sözlükler (müdürlük, mahalle) ve zorlanan/uyarı veren sözlük denetimi
- Belge türüne göre çokluk, kritiklik, zorunluluk, biçim kalıbı ve doğrulama politikası
- Müdürlük ve belge türü listelerinin OCR servisine istekle taşınması; serviste gömülü sözlük yok

Arayüzde örnek kayıtlar yanında yerel pilotta yüklenen gerçek dosyalar da bulunur. Dosyalar D1 üst verisine ve R2 uyumlu asıl dosya kasasına yazılır; yerel PaddleOCR servisi kuyruğu tüketerek metin, güven ve kanıt koordinatlarını kalıcılaştırır. Personel OCR alanlarını onaylayıp düzeltebilir; arşivleme sonrasında kayıt salt okunur olur ve her işlem özet zincirli denetim izinde saklanır. Roller ve müdürlük kapsamı artık tüm belge API’lerinde sunucu tarafında uygulanır. Bir sonraki dilim kullanıcı yönetim ekranı, belediyenin seçilecek kimlik sağlayıcısı ve gerçek pilot belge setiyle ölçümdür.

## Kimlik ve yetkilendirme

Roller ve yetkiler `lib/authorization.ts` içinde tanımlıdır; davranışı
`tests/authorization.test.ts` her rol × her yetki için doğrular. Görüntüleme
(`document.read`) ve indirme (`document.download`) ayrı yetkilerdir: görüntüleyici
rolü belge dosyasını indiremez. İkisi de denetim kaydı üretir ve denetim kaydı
yazılamazsa dosya sunulmaz.

E-posta karşılaştırması locale bağımsız küçültme kullanır. Türkçe locale ile
`"IBRAHIM"` değeri `"ıbrahim"` olur ve kayıtla eşleşmez; şema sürüm 5 bu şekilde
bozulmuş kayıtları onarır.


Üretimde kullanıcı e-postası yalnızca güvenilir platform veya belediye ters vekil sunucusunun ilettiği `oai-authenticated-user-email` başlığından alınır. İnternetten gelen aynı adlı istemci başlığı güvenilir ağ katmanında silinip yeniden yazılmalıdır. İlk yöneticiler `ARCHIVE_ADMIN_EMAILS` ile tanımlanır. Başlıksız yerel pilot yöneticisi yalnızca `localhost` geliştirmesinde etkindir; üretimde çalışmaz.
## Çalıştırma

```bash
npm install
npm run dev
```

Uygulama: `http://localhost:3000/archive`

Yerel OCR servisi ayrı süreçte çalışır:

```bash
cd services/ocr
docker build -t sivas-arsiv-ocr .
docker run --rm -p 8090:8090 sivas-arsiv-ocr
```

## Veri modeli ve şema

Yetkili DDL kaynağı `lib/archive-schema.ts` dosyasıdır ve `schema_state.version`
ile sürümlenir. `db/schema.ts` yalnız Drizzle tip aynasıdır (sorgu üretmez);
`drizzle/` altındaki göç zinciri 0.1 sürümünde donduruldu (bkz. `drizzle/README.md`).

**Şema değişikliği nasıl yapılır:**

1. `lib/archive-schema.ts` içindeki DDL'i güncelle.
2. `ARCHIVE_SCHEMA_VERSION` değerini artır ve `migrations` listesine karşılık gelen
   adımı ekle. Adım kolon yokluğuna değil sürüme göre planlanır.
3. `db/schema.ts` aynasını aynı kolonlarla güncelle.
4. `node --test "tests/schema-*.test.ts"` çalıştır: taze kurulum, sürüm 1'den
   yükseltme, kısıtların uygulanması ve iki tanımın kolon düzeyinde eşliği denetlenir.

Beklenen kolon listesi elle tutulmaz; `SCHEMA_MANIFEST` DDL'in kendisinden
türetilir ve göç sonrası doğrulama bununla yapılır. Doğrulama geçmeden sürüm
damgası yazılmaz, böylece eksik şema sessiz kalmaz.

**Göç nasıl uygulanır:** İstek yolu şema değiştirmez; rotalar yalnız sürümü
doğrular ve geride ise 503 döner. Göç yetkili uç noktadan çalışır:

```bash
curl -X POST https://arsiv.example/api/admin/migrate -H "Authorization: Bearer $ARCHIVE_MIGRATION_TOKEN"
```

`GET` aynı uç noktada mevcut ve beklenen sürümü döndürür. Yetki rol sistemiyle
verilemez, çünkü taze bir veritabanında kullanıcı tablosu henüz yoktur; bu yüzden
`ARCHIVE_MIGRATION_TOKEN` ortam sırrı kullanılır ve tanımlı değilse uç nokta
kapalıdır. `localhost` üzerinde göç geliştirme kolaylığı için kendiliğinden
uygulanır.

**PostgreSQL:** DDL bilinçli olarak SQLite lehçesindedir. Taşıma, üretim yerleşimi
kararına bağlıdır (ANA_SISTEM_TASARIM_BELGESI.md §16) ve gözden geçirilecek
noktalar `lib/archive-schema.ts` başında listelenmiştir.

Alan kuralları **veritabanında** tutulur:

| Katman | Rolü |
|---|---|
| `document_types` | Sürümlü belge türü profilleri; `valid_to` ile kapatılır, silinmez |
| `field_definitions` | Profil başına alan çokluğu, kritiklik, zorunluluk, biçim kalıbı, sözlük bağı |
| `vocabularies` / `vocabulary_terms` | Kontrollü listeler (müdürlük, mahalle) sürüm, sahip ve kaynak bilgisiyle |
| `lib/archive-seed.ts` | Başlangıç profil ve sözlük **verisi** (iş kuralı değil); idempotent tohumlama |
| `lib/document-profile.ts` | Profili veritabanından okur, 60 saniyelik önbellekle sunar |
| `lib/field-policy.ts` | Yüklenen tanımı uygular: risk seviyesi, biçim ve sözlük ihlali |

Bir kuralı değiştirmek için kod değil profil verisi güncellenir (ADR-008). Yeni
kural sürümü gerektiğinde `profile_version` artırılır ve eski sürüm kapatılır.
Tohumlanan profillerin durumu `HYPOTHESIS`'tir: ilgili müdürlük, arşiv birimi ve
hukuk/KVKK onayı almadan `VALIDATED` sayılmazlar.

Yürürlükteki profiller ve kontrollü listeler `GET /api/profiles` ile okunur;
yükleme ve doğrulama ekranları seçeneklerini buradan alır.

## Doğrulama

```bash
npm test
npm run lint
npx tsc --noEmit
```

`tests/*.test.ts` dosyaları saf mantığı gerçekten çalıştırır (yetkilendirme,
arama normalleştirmesi); `tests/*.test.mjs` dosyaları sözleşme ve regresyon
denetimi yapar.

## Liste, sayfalama ve bakım işleri

`GET /api/documents` anahtar kümesi (keyset) sayfalama kullanır: `limit` (en fazla
200), `status` (virgülle ayrılmış belge durumu) ve `cursor` parametreleri alır,
`page.nextCursor` döndürür. Durum süzmesi sunucuda yapılır — istemcide süzmek
sayfalanmış bir kümede eksik liste üretir.

Bütün arşivi dolaşan işler (arama dizini yenilemesi) göç adımının içinde
çalıştırılmaz; `maintenance_tasks` tablosunda kilitli, imleçli ve kaldığı yerden
devam eden iş olarak tutulur:

```bash
curl -X POST https://arsiv.example/api/admin/maintenance
```

Her çağrı sınırlı bir dilim işler ve ilerlemeyi kalıcılaştırır; `remaining`
sıfırlanana kadar tekrar çağrılır. Durum `/api/overview` içinde `maintenance`
alanında da görünür.

## Belge dosyasına erişim

Görüntüleme ve indirme **ayrı nesneler** döndürür:

| Yetki | Sunulan nesne |
|---|---|
| `document.read` | Kontrollü erişim türevi (`access`) |
| `document.download` | Değiştirilemez asıl (`original`) |

Görsel erişim türevleri OCR hattında, PDF erişim türevleri ise izole PDFium
renderer'ında üretilir. PDF görüntüleme hiçbir durumda asıl nesneye geri düşmez;
tamamlanmış ve segment aralıkları eksiksiz bir üretim kuşağı yoksa uç nokta 425
döndürür. Asıl indirme ayrı `document.download` yetkisi ve denetim olayı ister.

## Bilinen açık kalemler

- Depolama kapasitesi, yedekleme ve servis sağlığı kodda ölçülür; gerçek eşik,
  ikinci hata alanı ve alarm kanalı kurum içi staging pilotunda kanıtlanmalıdır.
- Politika öncesi yüklenmiş nesne anahtarları dosya adı içerir. Asıl nesne
  değiştirilemez olduğu için bunlar yalnız yetkili yeniden kabulle taşınabilir;
  sayı `/api/overview` içinde `storage.legacyKeys` olarak raporlanır.
- Denetim olayı bulunan bir belge silinemez (tetikleyici engeller). Hatalı kayıtlar
  için saklama-imha iş akışı gerekir; bu ayrı bir iş paketidir.
- PDF renderer'ının gerçek `DERIVATIVE_FILES` bağı, salt-okunur asıl kimliği,
  registry imaj özeti ve T-03 staging kanıtı henüz canlı ortamda doğrulanmalıdır.
- Tek kullanımlık görüntüleme bileti, byte-range oturumu ve görev ayrılığı F1.9
  kapsamında uygulanmıştır; canlı negatif kanıt T-04/T-05/T-06/K-4 koşularını bekler.
- Faz 0 kod kapısı imzalı dağıtım ve pilot kanıt workflow'larıyla hazırdır;
  kurum içi staging makinesi/runner/sırlar kurulup gerçek pilot belge cron OCR'ı
  ve personel arşivlemesinden geçmeden Faz 0 tamamlanmış sayılmaz.

OCR servisi testleri ayrı çalışır (`fastapi` ve `paddleocr` kurulu bir ortam gerekir):

```bash
cd services/ocr && PYTHONPATH=. python -m unittest discover -s tests -t . -p "test_*.py"
```

Mimari ve yol haritası için `PROJE_PLANI.md` ile `YOL_HARITASI_FAZLAR.md`;
Faz 1 kararları için ADR-013–017 ve `FAZ_1_KANIT_REHBERI.md`; diğer modellerle
eşit koşullu karşılaştırma için `MODEL_KARSILASTIRMA_PROMPTU.md` dosyasına bakın.
