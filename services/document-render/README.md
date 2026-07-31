# Belge Render Servisi (ADR-015)

PDF asılların 150 DPI, doğrusallaştırılmış ve aktif içerik taşımayan erişim
türevlerini üretir. Asıl PDF salt-okunur kimlikle indirilir, sayfalar PDFium
ile raster olarak yeniden çizilir, bölümler (`>512 MiB` belgelerde sayfa
aralıklı) türev alanına bu servisin yazma kimliğiyle koşullu yazılır ve
Worker'a yalnız bölüm kanıtları döner.

## Ortam değişkenleri

| Değişken | Amaç |
|---|---|
| `DOCUMENT_RENDER_SERVICE_TOKEN` | Zorunlu servis anahtarı; tanımsızsa uç 503 verir (fail-closed) |
| `RENDER_ORIGINAL_BUCKET` | Asıl kasa (salt-okunur kimlik) |
| `RENDER_DERIVATIVE_BUCKET` | Türev alanı (yalnız koşullu yazma) |
| `RENDERER_IMAGE_DIGEST` | Registry'nin verdiği `sha256:<64-hex>` imaj özeti; Worker beklentisiyle eşleşir |
| `RENDER_S3_ENDPOINT_URL` | S3 uyumlu uç nokta (R2 için hesap uç noktası) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Kova+işlem kapsamıyla sınırlı kimlik |

## Sınırlar (ADR-015)

- Belge başına en çok 2.000 sayfa; sayfa başına en çok 100 megapiksel.
- Bölüm başına en çok 512 MiB ve iş başına en çok 90 bölüm; daha büyük çıktı
  atomik sonlandırma sınırı nedeniyle operatör incelemesine alınır.
- Parola korumalı/bozuk PDF veya sınır aşımı yapılandırılmış
  `422 {detail:{code:"REVIEW_REQUIRED"}}` yanıtı döndürür; asıl PDF'ye
  görüntüleme fallback'i hiçbir durumda açılmaz.
- Worker'ın verdiği kararlı `renderId` nesne anahtarında kullanılır. Yanıt kaybı
  sonrası aynı iş yeniden denenirse var olan segment metadata kanıtı doğrulanır;
  Worker yine bütün baytları okuyup tam SHA-256 hesaplar.

## Testler

```bash
python services/document-render/tests/test_planning.py
```

Saf bölümleme/sınır testleri pdfium kurulumu gerektirmez. Uçtan uca render
kanıtı staging kabul koşusuna (F1.11, T-03) aittir.
