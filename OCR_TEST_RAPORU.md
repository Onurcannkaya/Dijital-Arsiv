# Gerçek OCR Test Raporu — test_belge.jpeg

## Test özeti

- Belge: 1996 tarihli Şarkışla Belediyesi Encümen Kararı
- Arşiv referansı: `ARS-2026-6C472023`
- Görüntü: JPEG, 971 × 1600 piksel, 156.940 bayt
- SHA-256: `018fa4f5533833f1449641aa27ea8d50dbd1c9b8827a90487c75a9cfddb63a8d`
- Motor: PaddleOCR 3.7.0 / PP-OCRv5, Windows CPU
- Nihai işlem hattı: `PP-OCRv5+clahe-auto`

## Karşılaştırma

| Varyant | Metin bölgesi | Ortalama güven | Çıkarılan alan | Sonuç |
|---|---:|---:|---:|---|
| Ham görüntü | 29 | %87,49 | 0 | Soluk yazıların önemli bölümü kaçtı |
| 1600 px algılama + eşik | 27 | %92,05 | 0 | Düşük güvenli gürültü elendi, kapsama artmadı |
| Otomatik CLAHE + keskinleştirme | 49 | %95,00 | 5 | Seçilen en iyi varyant |
| Adaptif siyah-beyaz | 47 | %88,58 | 4 | Daha düşük güven; reddedildi |

## Nihai alanlar

| Alan | Değer | Güven | Kanıt |
|---|---|---:|---|
| Belge türü | Encümen karar sureti | %94,48 | “... Encümen kararıyla ...” |
| Belge tarihi | 11.09.1996 | %90,65 | “11.09.1996” |
| Mahalle | Kandemir | %98,94 | “Kandemir Mahallesi,32 ada,2 nolu parselin imar” |
| Ada | 32 | %98,94 | Aynı kanıt satırı |
| Parsel | 2 | %98,94 | Aynı kanıt satırı |
| İlgili müdürlük | Belirlenmedi | %0 | OCR tarafından bulunamadı; personel girişi zorunlu |

Belge uygulamada `review` durumundadır. Müdürlük tamamlanmadan “Doğrula ve arşivle” işlemi yapılamaz.

## Metin kalitesi değerlendirmesi

Belgenin başlığı, karar numarası, tarihi, ana karar konusu, mahalle, ana ada/parsel ve uzun parsel listelerinin büyük bölümü okunmuştur. Bununla birlikte tam metinde eski baskı ve düşük kontrast nedeniyle karakter düzeyinde hatalar vardır. Örnekler:

- `1580 sayılı` bazı satırlarda `isao sayili`
- `ile` bazı yerlerde `11e`
- `Sicil Müdürlüğü` bazı yerlerde `Sici1 Müdürlüğü`
- Uzun parsel listelerinde `0/6`, `1/l`, `8/3` karışmaları

Bu nedenle sonuç arama, tasnif ve alan önerisi için başarılıdır; hukuki tam metin veya uzun parsel listesi için personel doğrulaması gereklidir. Karakter düzeyinde kesin doğruluk oranı, onaylı bir insan transkripti olmadan hesaplanamaz.

## Test sırasında düzeltilen üretim riskleri

1. Windows CPU oneDNN uyumsuzluğu güvenli ayarla kapatıldı.
2. Soluk taramalar otomatik ölçülüp CLAHE ile iyileştiriliyor.
3. Gerçek siyah-beyaz taramalar gereksiz tekrar işlemden korunuyor.
4. `32 ada, 2 nolu parsel` ifadesi sonraki uzun parsel listesinden doğru ayrılıyor.
5. Kalıcı hataya düşmüş OCR işleri seçili belge için yeniden denenebiliyor.
6. Belge türüne göre eksik kritik alanlar personel kontrolüne zorlanıyor.
7. Sayfa koordinatları asıl görüntünün 971 × 1600 boyutuna göre saklanıyor.

## Çıktılar

- `outputs/test_belge_app_result.json`: uygulamadan alınan tam sayfa metni, kelime koordinatları ve alanlar
- `outputs/test_belge_paddleocr.json`: ham görüntü sonucu
- `outputs/test_belge_clahe_ocr.json`: seçilen iyileştirilmiş sonuç
- `outputs/test_belge_binary_ocr.json`: karşılaştırma için siyah-beyaz sonuç