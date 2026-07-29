# Sivas Belediyesi Dijital Arşiv — Başlangıç Planı

## Ürün kararı

İlk sürüm tam bir EBYS yerine, mevcut EBYS ve müdürlük sistemleriyle entegre olabilen bir **dijital arşiv ve akıllı belge işleme katmanı** olacak. Öncelik; değiştirilemez asıl dosyanın korunması, hızlı arama, yapay zekâ destekli alan çıkarımı ve insan doğrulamasıdır.

## Eski masaüstü uygulamasından korunanlar

- Belge küçük resimleri + belge görünümü + alan formundan oluşan üç bölmeli inceleme akışı.
- Mahalle, ada, parsel, muhatap ve müdürlük gibi kuruma özgü alanlar.
- `mahalle:`, `ada:`, `parsel:` benzeri hızlı arama yaklaşımı.
- Ada/parsel ve sokak ilişkileri ile harita entegrasyonuna uygun veri modeli.
- Toplu işleme ve arka planda OCR fikri.

## Eski uygulamada düzeltilmesi gerekenler

1. Belgenin tamamının ve kişisel verilerin zorunlu olarak Gemini'ye gönderilmesi kaldırılacak. Yerel OCR birincil yol olacak; bulut yalnızca açık politika ve yetkiyle seçilebilir yedek yol olabilir.
2. Dolu alan sayısı OCR güveni olarak kullanılmayacak. Her alan için gerçek model güveni, kanıt bölgesi, sözlük doğrulaması ve kurala dayalı risk skoru ayrı tutulacak.
3. Düşük risk eşiğini geçse bile kritik alanlar (T.C. kimlik, ada/parsel, tarih, imza vb.) politika gerektiriyorsa insan onayına gidecek.
4. Varsayılan parola ve tuzsuz SHA-256 yerine kurumsal kimlik sağlayıcı, sunucu taraflı yetkilendirme ve güçlü parola türetme kullanılacak.
5. MD5 yerine SHA-256 kullanılacak; asıl dosya değiştirilemez tutulacak, türev PDF/OCR metni ayrı nesneler olacak.
6. Ada/parsel değerlerindeki `12/A`, `3-B` gibi hukuki ekler silinmeyecek.
7. Masaüstüne bağlı iş parçacıkları yerine kalıcı kuyruk, tekrar deneme ve hata karantinası kullanılacak.
8. Mahalle sözlüğü kod içine yazılmayacak; yetkili kaynaktan sürümlenen kontrollü sözlük olacak.
9. Arayüzdeki rol kontrolü güvenlik sayılmayacak; her işlem sunucuda yetki ve denetim kaydı ile korunacak.

## Hedef mimari

- **Pilot web kabuğu:** React 19 tabanlı PWA. Mevcut Vinext/Next uyumluluk katmanı
  yalnız dikey pilot teslim aracıdır; kurumsal çekirdek mimari kararı değildir.
- **Uygulama API'si:** Kurumsal kimlik, yetki, arama ve iş akışını taşıyan bağımsız
  servis sınırı. Production teknoloji seçimi belediyenin işletim standartları ve
  mimari kurul kararıyla (.NET/Java veya eşdeğer kurumsal platform) kesinleşir.
- **OCR/AI servisi:** Python + FastAPI; PaddleOCR ana motor, gerektiğinde yerel görsel-dil modeli yedek motor.
- **Veri:** PostgreSQL (üst veri ve iş akışı), S3 uyumlu nesne depolama (asıl ve türev dosyalar), OpenSearch/PostgreSQL full-text (arama).
- **Kuyruk:** Redis/RabbitMQ tabanlı kalıcı görev kuyruğu.
- **Gözlemlenebilirlik:** İş kimliği, model sürümü, süre, hata, kullanıcı düzeltmesi ve denetim kayıtları.

## Belge işleme hattı

1. Yükleme ve virüs kontrolü.
2. SHA-256, dosya türü doğrulama ve değiştirilemez asıl dosya kaydı.
3. Sayfa ayırma, eğrilik/gürültü düzeltme ve görüntü kalite ölçümü.
4. Yerel OCR ve sayfa düzeni analizi.
5. Belge türü sınıflandırma ve şema tabanlı alan çıkarımı.
6. Kurumsal sözlük, biçim ve çapraz alan doğrulamaları.
7. Alan bazlı güven + risk yönlendirmesi.
8. Personel doğrulaması; her düzeltmenin öğrenme verisi olarak kaydı.
9. Arama dizini, saklama planı, erişim politikası ve arşiv paketi üretimi.

## Standart omurgası

- Türkiye: TS 13298, Devlet Arşiv Hizmetleri Hakkında Yönetmelik, Standart Dosya Planı, KVKK ve Cumhurbaşkanlığı Bilgi ve İletişim Güvenliği Rehberi.
- Uluslararası: ISO 15489, ISO 23081, ISO 14721 (OAIS), ISO 19005 (PDF/A), ISO 27001 ve WCAG 2.2 AA.
- Standartların güncel sürümü, kapsamı ve kurum için bağlayıcılığı uygulama öncesi hukuk/arşiv/bilgi işlem birimleriyle teyit edilecek.

## Yol haritası

### Faz 0 — Teslim hattı ve çalışabilir omurga

Uygulanıyor: ADR-012 depolama soyutlaması, Cron Trigger tabanlı OCR/bakım/bütünlük
işleri, exponential backoff ve dead-letter görünürlüğü, yapılandırılmış log,
korelasyon kimliği, `/api/health`, kuyruk metrikleri, model gömülü OCR imajı,
dev/staging/production ortam sözleşmesi ve CI kalite kapıları eklendi.

Çıkış kapısı kodun derlenmesi değildir. Staging'de bir belge yükleme → otomatik OCR
→ doğrulama → arşivleme zinciri elle yönetim uç noktası çağrılmadan tamamlanmalı;
dağıtım sonrası şema göçü ve readiness denetimi geçmelidir. İşletim adımları ve dış
bağımlılıklar `FAZ_0_ISLETIM_REHBERI.md` içinde tutulur.

Bu faz D1/R2/Vinext pilotunu üretim hedefi ilan etmez. Müdürlük yönetiminin
“Next.js tabanlı kurumsal çekirdek olmayacak” kısıtı korunur; Faz 0'da kurulan
depolama, iş kuyruğu, OCR sözleşmesi, gözlemlenebilirlik ve göç kapıları sonraki
kurumsal servis uygulamasına taşınabilir sınırlar olarak ele alınır.

### Aşama 1 — Çalışan ürün kabuğu

Tamamlandı: responsive PWA kabuğu, genel bakış, gelen evrak, arşiv listesi, arama ve belge doğrulama prototipi.

### Aşama 2 — Dikey pilot

Tamamlandı: gerçek dosya yükleme, SHA-256 tekrar/bütünlük kontrolü, D1 üst verisi, R2 asıl dosya kasası, kalıcı `paddleocr-local` kuyruğu, PaddleOCR/FastAPI işleyicisi, alan kanıtlarının koordinat ve güvenle saklanması, personel düzeltme/onayı, kontrollü arşivleme ve SHA-256 zincirli değiştirilemez denetim izi. Sırada kurumsal kimlik/rol yetkileri ve gerçek pilot belge setiyle doğruluk-hız ölçümü var.

### Aşama 3 — Kurumsal güvenlik

Başlatıldı: güvenilir kimlik başlığı, yönetici/arşiv yöneticisi/doğrulayıcı/görüntüleyici rolleri, müdürlük kapsamı, tüm belge API’lerinde sunucu yetkisi ve değiştirilemez denetim izi tamamlandı. Sırada kullanıcı yönetim ekranı, belediye kimlik sağlayıcısı entegrasyonu, saklama-imha akışları, yedekleme ve felaket kurtarma var.

### Aşama 4 — Öğrenen tasnif

Düzeltmelerden veri seti, belge türü başına ölçüm, aktif öğrenme, yerel model karşılaştırmaları ve maliyet/başarı panosu.

### Aşama 5 — Entegrasyon ve yaygınlaştırma

EBYS, e-imza, KEP, GIS ve müdürlük uygulamaları; toplu aktarım, arşiv paketleri ve kurum geneli devreye alma.
