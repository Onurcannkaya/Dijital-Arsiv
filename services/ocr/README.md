# Sivas Arşiv Yerel OCR Servisi

Bu servis, belediye belgelerini kurum içinde PaddleOCR ile işler. Asıl dosya geçici çalışma alanına alınır; OCR tamamlanınca geçici kopya silinir. Uygulamaya sayfa metni, kelime koordinatları, gerçek model güveni ve alan kanıtları döner.

## Çalıştırma

```bash
docker build -t sivas-arsiv-ocr .
docker run --rm -p 8090:8090 -e OCR_SERVICE_TOKEN=guclu-bir-servis-anahtari sivas-arsiv-ocr
```

CPU pilotunda `PADDLEOCR_DEVICE=cpu`, GPU sunucusunda uygun PaddlePaddle/CUDA imajı ve `PADDLEOCR_DEVICE=gpu:0` kullanılmalıdır. Model dosyaları üretimde önceden indirilip kurum içi model deposundan sunulmalıdır.

Servis sözleşmesi `POST /v1/ocr`; sağlık kontrolü `GET /health` adresindedir.

## CPU ve eski tarama ayarları

Windows CPU çalıştırmasında oneDNN uyumsuzluklarını önlemek için `PADDLEOCR_ENABLE_MKLDNN=false` varsayılandır. Algılama uzun kenar sınırı küçük yazılar için 1600 pikseldir. `PADDLEOCR_PREPROCESS=auto`, çok açık ve düşük kontrastlı eski taramaları ölçerek yalnızca gerekli olduğunda CLAHE + keskinleştirme uygular; gerçek siyah-beyaz görüntüler tekrar işlenmez. Uygulanan ön işlem model adına `+clahe-auto` olarak eklenir.

`test_belge.jpeg` gerçek testinde ham görüntü 29 metin bölgesi/%87,49 güven üretirken otomatik iyileştirme 49 bölge/%95 güven üretmiştir.