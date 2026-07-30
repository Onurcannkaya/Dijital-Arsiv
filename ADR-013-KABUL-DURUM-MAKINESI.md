# ADR-013 — Belge Kabul Durum Makinesi ve Çalışma Zamanı Bağımsızlığı

- Durum: Teknik karar kabul edildi — kurumsal onay bekliyor
- Tarih: 2026-07-30
- Kapsam: Güvenilmeyen dosyanın yükleme oturumundan kabul edilmiş asıl nesneye dönüşmesi
- Sahip: Bilgi İşlem
- Gerekli kurumsal onaylar: Bilgi İşlem, Bilgi Güvenliği, Arşiv

## Bağlam

Mevcut yükleme rotası dosyayı tek istekte alıp depolama ve belge kaydı oluşturmaya
çalışır. Büyük dosya, bağlantı kesintisi, aynı isteğin yinelenmesi, tarama hatası
ve nesne yazıldıktan sonra veritabanı sonlandırmasının başarısız olması ayrı,
kanıtlanabilir durumlar değildir. Kabul iş kuralının Next.js, Vinext, Cloudflare
Worker veya tek bir nesne sağlayıcısına bağlanması kurumsal çekirdeğin
taşınabilirliğini de engeller.

## Karar

Kabul hattı sağlayıcıdan ve web çatısından bağımsız bir durum makinesi olarak
uygulanır:

```text
CREATED
  -> UPLOADING
  -> QUARANTINED
  -> SCANNING
  -> VERIFIED
  -> PROMOTING
  -> ACCEPTED
```

Terminal veya inceleme gerektiren durumlar:

- `REJECTED`: Tür, ayrıştırma veya zararlı içerik politikası reddi.
- `DUPLICATE`: Sunucunun hesapladığı SHA-256 mevcut kabul edilmiş asılla eşleşir.
- `EXPIRED`: Başlatılmış oturum zamanında tamamlanmamıştır.
- `FAILED`: Altyapı veya doğrulama hatası otomatik tekrar sınırını aşmıştır.

`FAILED` son kullanıcı için terminaldir; kullanıcı eylemiyle yeniden açılmaz.
Terfi aşamasında oluşan `FAILED`, karantina nesnesi ve `VERIFIED` kabul alındısı
hâlâ geçerliyken yetkili operatör komutuyla `PROMOTING` durumuna yeniden
alınabilir. Bu komut ayrı yetki, gerekçe ve denetim olayı gerektirir; yeniden
deneme penceresi karantina saklama süresiyle sınırlıdır. Pencere dolduğunda veya
karantina nesnesi temizlendiğinde oturum kalıcı `FAILED` kalır ve yeni yükleme
oturumu gerekir.

İzinli geçiş listesi dışında durum güncellenemez. Her geçiş;
`upload_session_id`, beklenen mevcut durum, `state_version`, korelasyon kimliği
ve denetim olayıyla koşullu yapılır. Olay özeti; sabit alan sırasıyla önceki olay
özetini, oturum/sürüm, eski-yeni durum, aktör, gerekçe, kanıt alındısı ve zamanı
içeren UTF-8 JSON üzerinden SHA-256 olarak hesaplanır; böylece olaylar zincirlidir.
Aynı komutun yeniden çalışması aynı sonucu
döndürür; ikinci belge, asıl nesne veya OCR işi üretmez.

İdempotency anahtarı kiracı, kullanıcı ve işlem amacı kapsamında benzersizdir.
Anahtarın ömrü yükleme oturumunun ve güvenli yeniden deneme penceresinin sonuna
kadar en az 24 saattir. Aynı anahtar farklı dosya boyutu veya bildirilen türle
yeniden kullanılırsa `IDEMPOTENCY_CONFLICT` sonucu verilir.

Mükerrerlik kararında istemci SHA değeri kanıt sayılmaz. Tamamlanan karantina
nesnesi güvenilir hizmet tarafından akışla okunur ve SHA-256 sunucuda hesaplanır.
Eşleşme varsa oturum `DUPLICATE` olur:

- yeni `archive_documents`, `binary_objects` veya OCR işi oluşturulmaz;
- kullanıcı mevcut belgeye yetkiliyse belge kimliği gösterilebilir;
- yetkisiz kullanıcıya yalnız genel mükerrer içerik sonucu verilir;
- `binary_objects` üzerindeki `original` sınıfı kısmi SHA-256 benzersiz indeksi
  yarış durumuna karşı son güvenlik kapısıdır.

## Çalışma zamanı sınırı

Durumlar, komutlar, hata kodları ve geçiş kuralları `lib/ingest-contract.ts` ve
`lib/ingest-state-machine.ts` içinde saf alan kodu olarak tutulur. Bu katman:

- Next.js/Vinext, Cloudflare veya R2 tipi içe aktarmaz;
- HTTP isteği, zaman, kimlik, kuyruk, veritabanı ve nesne deposuna portlar
  üzerinden erişir;
- sağlayıcı belirteçlerini opak değer olarak taşır;
- Node ve Worker çalışma zamanlarında aynı sözleşme testlerini geçer.

HTTP rotaları yalnız kimlik doğrulama, girdi eşleme ve alan komutunu çağırma
işini yapar. Kabul iş kuralı `worker/index.ts` veya rota dosyalarına yazılmaz.

## Hata sözleşmesi

Kullanıcıya sağlayıcı hatası veya nesne anahtarı sızdırılmaz. En az şu sabit
alan hata kodları kullanılır:

- `TYPE_MISMATCH`
- `UNSUPPORTED_CONTENT`
- `MALWARE_DETECTED`
- `SCAN_UNAVAILABLE`
- `SIZE_LIMIT_EXCEEDED`
- `PART_CHECKSUM_CONFLICT`
- `IDEMPOTENCY_CONFLICT`
- `DUPLICATE_CONTENT`
- `PROMOTION_CONFLICT`
- `POST_WRITE_INTEGRITY_FAILURE`
- `SESSION_EXPIRED`

Altyapı hataları `FAILED` durumuna doğrudan geçmek yerine tanımlı tekrar
politikasını tüketir. Politika reddi otomatik tekrar edilmez.

## Sonuçlar

- Kesinti ve tekrar deneme davranışı veritabanında görülebilir ve test edilebilir.
- Web çatısı veya depolama sağlayıcısı değişse de kabul semantiği korunur.
- Mükerrer içerik varlığı yetkisiz kullanıcıya sızdırılmaz.
- Durum değişiklikleri için `state_version` ve koşullu güncelleme gerekecektir.

## Doğrulama

- İzin verilmeyen her durum geçişi reddedilir.
- Aynı komut ve idempotency anahtarı yinelendiğinde tek yan etki oluşur.
- Eşzamanlı iki terfi denemesinde yalnız biri kabul edilir.
- Sahte istemci SHA değeri mükerrerlik kararını değiştirmez.
- Alan paketi Node ve Worker sözleşme testlerini aynı sonuçla geçer.

