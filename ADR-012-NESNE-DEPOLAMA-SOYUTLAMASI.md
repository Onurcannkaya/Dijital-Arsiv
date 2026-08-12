# ADR-012 — Nesne Depolama Soyutlaması

- Durum: Kabul edildi
- Tarih: 2026-07-29
- Kapsam: Asıl belgeler, erişim türevleri ve OCR çıktıları

## Karar

Uygulama kodu `R2Bucket` veya sağlayıcıya özgü S3 istemcisini doğrudan çağırmaz.
Bütün nesne işlemleri `lib/object-storage.ts` içindeki `ObjectStorage` sözleşmesinden
geçer. İlk adaptör `R2ObjectStorage`'dır. Kurum içi kurulum için aynı sözleşmeyi
uygulayan S3 uyumlu adaptör eklenir; belge ve iş akışı kodu değişmez.

`binary_objects` tablosu nesnelerin yetkili envanteridir. Depolama sağlayıcısının
liste sonucu uygulama kaydı sayılmaz. Nesne anahtarı, sınıfı, boyutu, SHA-256 özeti,
türetildiği nesne ve üretici sürümü D1/kurumsal veritabanında tutulur.

## Zorunlu davranışlar

- Asıl nesne üzerine yazılmaz; yeni kabul yeni kimlik ve yeni anahtar üretir.
- Silme, saklama-imha politikası ve denetim izi olmadan iş akışına açılmaz.
- Uygulama rotalarında doğrudan `ARCHIVE_FILES.get/put/delete/head/list` çağrısı
  bulunamaz; sözleşme testi bunu denetler.
- Bütünlük taraması nesnenin varlığını, boyutunu ve kayıtlı SHA-256 metadatasını
  dilimler hâlinde kontrol eder.
- Adaptör hataları kullanıcıya sağlayıcı ayrıntısı sızdırmadan korelasyon kimliğiyle
  yapılandırılmış sunucu günlüğüne yazılır.

## Sonuçlar

R2, S3 uyumlu kurum deposu veya test belleği aynı uygulama katmanıyla kullanılabilir.
Sağlayıcıya özgü özellik eklemek gerektiğinde önce genel sözleşmeye açık bir yetenek
olarak eklenir; rotalara kaçak istemci çağrısı eklenmez.
