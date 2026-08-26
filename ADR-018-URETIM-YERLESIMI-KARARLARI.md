# ADR-018 — Üretim Yerleşimi ve İş Etki Analizi Kararları

- Durum: Kurumsal olarak onaylandı (karar dosyası imzalandı)
- Tarih: 2026-08-12
- Kapsam: Üretim yerleşimi, şifreleme, RPO/RTO, ikinci hata alanı, saklama, bütünlük işletimi, çıkış/imha
- Sahip: Bilgi İşlem
- Dayanak: `KARAR_DOSYASI_URETIM_YERLESIMI.md` (imzalı nüsha kurum arşivinde);
  `S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md` "üretim öncesi kararlar" listesi
- Onaylayanlar: Bilgi İşlem, Bilgi Güvenliği, Arşiv, Hukuk/KVKK

## Bağlam

Faz 1 pilotu Cloudflare (Workers + D1 + R2) üzerinde geliştirildi ve tasarım
belgesi bunu dikey pilot saydı. Üretim yerleşimi, anahtar sahipliği, hizmet
hedefleri ve saklama/imha yetkileri kurum sahiplerinin onayına bırakılmıştı.
Karar dosyasındaki yedi karar, teknik önerilerle birlikte kurumsal olarak
onaylandı; bu ADR onaylanan değerleri kalıcı kayda geçirir.

## Kararlar

1. **Üretim yerleşimi:** Kurum içi MinIO + Node yığını (Seçenek A).
   Cloudflare ortamı yalnız sentetik veriyle CI/deneme pilotu olarak
   tutulabilir; üretim verisi hiçbir koşulda buluta çıkmaz.
2. **Şifreleme/anahtar sahipliği:** 1. dalga sunucu disklerinde LUKS + MinIO
   erişim denetimi. 2. dalga MinIO KES ile SSE, kurum sahipliğinde anahtar ve
   yıllık dönüşüm (yol haritasında P9 dalgasına eklendi). Anahtar yedeği
   çevrimdışı kasada, iki ayrı yetkilide.
3. **RPO/RTO ve kapasite:** ADR-017 pilot tablosu ÜRETİM hedefi olarak
   onaylandı (üst veri 15 dk/4 sa; kabul edilmiş asıllar 1 sa/8 sa; türevler
   24 sa/24 sa). Geri yükleme tatbikatı hedefi buna bağlanır:
   `ACCEPTANCE_RESTORE_RTO_SECONDS=28800`. Yıllık hacim/büyüme tahmini Yazı
   İşleri + Arşiv'den alınacak **açık girdidir** (aşağıda).
4. **İkinci hata alanı ve soğuk yedek:** İl içinde ayrı belediye tesisinde
   ikinci MinIO (site replication); aylık çevrimdışı manifest + içerik
   kopyası, harici salt-okunur ortamda. T-10 taşınabilirlik testi ikinci
   MinIO'yu hedef alır.
5. **Saklama:** İlk üretim döneminde tasfiye KAPALI (süresiz bekletme):
   varsayılan bekletme süresi tanımlanmaz, tasfiye kimliği hiç açılmaz,
   silme yetkisi hiçbir uygulama rolünde bulunmaz. Dosya planı eşlemesi
   tamamlandığında sınıf bazlı bekletme yeni ADR sürümüyle devreye alınır.
   **Teknik uzlaştırma:** S3 Object Lock sonsuz süre kabul etmediğinden iş
   kaydındaki “süresiz/tasfiye kapalı” kararı fiziksel WORM süresiyle aynı
   kavram değildir. ADR-020, otomatik tasfiyeyi kapalı tutarken asıl kovada
   kurulca onaylanan sonlu bir COMPLIANCE alt sınırı uygular; bu sürenin
   dolması silme yetkisi veya tasfiye kararı üretmez.
6. **Bütünlük işletimi:** Uzlaştırma günlük; tam SHA taraması envanteri 30
   günde bir turlayan dilimli döngüde. KRİTİK bulguda anında alarm ve 1 iş
   günü içinde müdahale; açık kritik bulgu varken yeni müdürlük alımı durur.
7. **Çıkış/imha yetkilileri:** Arşiv + Bilgi İşlem + Hukuk/KVKK'dan oluşan
   kurul; uygulama dört göz ilkesiyle ayrı tasfiye kimliği üzerinden; her
   adım denetim kaydına bağlanır (ADR-016 tasfiye ilkeleriyle uyumlu).

## Açık girdiler (karar değil, veri bekleyen)

- Yıllık beklenen belge adedi/hacmi ve 5 yıllık büyüme tahmini (Karar 3'ün
  kapasite ayağı) — disk planı ve K-6 eşzamanlılık profili buna bağlanır.
- İkinci tesisin adresi/ağ ucu (Karar 4) — belirlendiğinde
  `ACCEPTANCE_SECOND_S3_ENDPOINT` ve replikasyon yapılandırması tanımlanır.

## Sonuçlar

- ADR-017'nin "iş etki analizi ve kurumsal onay bekliyor" durumu bu ADR ile
  kapanır; pilot hedef tablosu üretim hedefidir ve sessizce gevşetilemez.
- Kabul ortamı runbook'undaki RTO değişkeni 28800 sn olarak belirlenir;
  tatbikat ölçümleri bu hedefe karşı raporlanır.
- Kurum içi kurulum (`deploy/kurum-ici/AYAGA_KALDIRMA.md`) bu kararların
  uygulama zeminidir; üretim `.env` değerleri (kanonik alan adı,
  `APP_ENV=production`) kurulum sırasında bu ADR'ye göre doldurulur.
- KES/SSE işi ve dosya planına bağlı bekletme, ayrı işler olarak yol
  haritasına eklenmiştir; bu ADR'nin kapsamını değiştirmezler.
