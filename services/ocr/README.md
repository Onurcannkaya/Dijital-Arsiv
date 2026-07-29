# Sivas Arşiv Yerel OCR Servisi

Bu servis, belediye belgelerini kurum içinde PaddleOCR ile işler. Asıl dosya geçici çalışma alanına alınır; OCR tamamlanınca geçici kopya silinir. Uygulamaya sayfa metni, kelime koordinatları, gerçek model güveni ve alan kanıtları döner.

## Çalıştırma

```bash
docker build -t sivas-arsiv-ocr .
docker run --rm -p 8090:8090 -e OCR_SERVICE_TOKEN=guclu-bir-servis-anahtari sivas-arsiv-ocr
```

`OCR_SERVICE_TOKEN` **zorunludur**. Tanımlı değilse `/v1/ocr` 503 döner; servis
anahtarsız çalışmaz. Aynı değer uygulama tarafında da `OCR_SERVICE_TOKEN` olarak
tanımlanmalıdır.

## Sözlükler istekle taşınır

Müdürlük listesi ve belge türü tanıma işaretleri serviste gömülü değildir;
uygulama her istekte `profile` alanında gönderir (kontrollü sözlük ve yürürlükteki
belge türü profillerinden). Profil gönderilmezse bu alanlar çıkarılmaz — servis
kendi listesini uydurmaz. Kullanılan profil ve sözlük sürümü yanıtta döner ve
alan kaydıyla birlikte saklanır.

CPU pilotunda `PADDLEOCR_DEVICE=cpu` kullanılır. Docker derlemesi model dosyalarını
`download_models.py` ile imaja gömer; çalışma zamanı model indirmek için internete
çıkmaz. GPU kararı kuyruk derinliği ve P95 OCR süresi ölçüldükten sonra verilir;
uygun PaddlePaddle/CUDA tabanlı ayrı bir imaj profili doğrulanmadan yalnızca
`PADDLEOCR_DEVICE=gpu:0` değiştirerek production'a geçilmez.

Servis sözleşmesi `POST /v1/ocr`; sağlık kontrolü `GET /health` adresindedir.

## CPU ve eski tarama ayarları

Windows CPU çalıştırmasında oneDNN uyumsuzluklarını önlemek için `PADDLEOCR_ENABLE_MKLDNN=false` varsayılandır. Algılama uzun kenar sınırı küçük yazılar için 1600 pikseldir. `PADDLEOCR_PREPROCESS=auto`, çok açık ve düşük kontrastlı eski taramaları ölçerek yalnızca gerekli olduğunda CLAHE + keskinleştirme uygular; gerçek siyah-beyaz görüntüler tekrar işlenmez. Uygulanan ön işlem model adına `+clahe-auto` olarak eklenir.

`test_belge.jpeg` gerçek testinde ham görüntü 29 metin bölgesi/%87,49 güven üretirken otomatik iyileştirme 49 bölge/%95 güven üretmiştir.
