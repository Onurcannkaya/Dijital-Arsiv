# İçerik tarama servisi

Karantina nesnesini sabit, salt-okunur S3/R2 kimliğiyle indirir; boyut ve
SHA-256 kanıtını doğrular. PDF/JPEG/PNG/TIFF magic-byte, dosya uzantısı ve güvenli
ayrıştırıcı sonucu birlikte değerlendirilir. Son olarak ClamAV bütün dosyayı
tarar. İmza veritabanı yoksa veya 24 saatten eskiyse servis fail-closed davranır.

Zorunlu ortam değişkenleri:

- `CONTENT_SCAN_SERVICE_TOKEN`
- `CONTENT_SCAN_QUARANTINE_BUCKET`
- `CONTENT_SCAN_S3_ENDPOINT_URL` (AWS S3 için boş olabilir)
- yalnız `GetObject` yetkili `AWS_ACCESS_KEY_ID` ve `AWS_SECRET_ACCESS_KEY`

İstek kova veya uç adresi taşımaz. Servis kimliğine asıl, geçici, yazma, silme
ve listeleme yetkisi verilmez. Üretimde `/var/lib/clamav` güncel imzaların
yetkili güncelleme işiyle yazıldığı ayrı bir volume olmalıdır.

```bash
docker build -t sivas-arsiv-content-scan .
docker run --read-only --tmpfs /tmp:rw,noexec,nosuid,size=3g -p 8091:8091 \
  -e CONTENT_SCAN_SERVICE_TOKEN=... \
  -e CONTENT_SCAN_QUARANTINE_BUCKET=... \
  sivas-arsiv-content-scan
```
