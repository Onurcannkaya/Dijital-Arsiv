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

Arayüzde örnek kayıtlar yanında yerel pilotta yüklenen gerçek dosyalar da bulunur. Dosyalar D1 üst verisine ve R2 uyumlu asıl dosya kasasına yazılır; yerel PaddleOCR servisi kuyruğu tüketerek metin, güven ve kanıt koordinatlarını kalıcılaştırır. Personel OCR alanlarını onaylayıp düzeltebilir; arşivleme sonrasında kayıt salt okunur olur ve her işlem özet zincirli denetim izinde saklanır. Roller ve müdürlük kapsamı artık tüm belge API’lerinde sunucu tarafında uygulanır. Bir sonraki dilim kullanıcı yönetim ekranı, belediyenin seçilecek kimlik sağlayıcısı ve gerçek pilot belge setiyle ölçümdür.

## Kimlik ve yetkilendirme

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

Çalışma zamanı DDL kaynağı `lib/archive-schema.ts` dosyasıdır ve `schema_state.version`
ile sürümlenir. `db/schema.ts` Drizzle tip aynasıdır; `drizzle/` altındaki göç
zinciri 0.1 sürümünde donduruldu (bkz. `drizzle/README.md`). Alan çokluğu,
kritiklik, zorunluluk ve risk kuralları `lib/field-policy.ts` içinde tek
merkezde tanımlıdır; sürümlü belge türü profillerine taşınacaktır.

## Doğrulama

```bash
npm test
npm run lint
npx tsc --noEmit
```

OCR servisi testleri ayrı çalışır (`fastapi` ve `paddleocr` kurulu bir ortam gerekir):

```bash
cd services/ocr && PYTHONPATH=. python -m unittest discover -s tests -t . -p "test_*.py"
```

Mimari ve yol haritası için `PROJE_PLANI.md`, diğer modellerle eşit koşullu karşılaştırma için `MODEL_KARSILASTIRMA_PROMPTU.md` dosyasına bakın.