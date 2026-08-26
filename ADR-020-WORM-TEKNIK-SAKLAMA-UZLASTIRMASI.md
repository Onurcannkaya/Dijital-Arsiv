# ADR-020 — WORM Teknik Süresi ile İş Saklama Kararının Uzlaştırılması

- Durum: Uygulandı; üretim değeri kurul karar referansı olmadan açılamaz
- Tarih: 2026-08-26
- Kapsam: ADR-018 Karar 5, MinIO Object Lock ve otomatik tasfiye sınırı
- Sahipler: Bilgi İşlem + Arşiv + Hukuk/KVKK

## Sorun

ADR-018 ilk üretim döneminde tasfiyeyi kapatır ve iş kaydını süresiz
bekletir. S3 Object Lock COMPLIANCE ise nesneyi yalnız belirli bir tarihe
kadar kilitler; “sonsuz” bir retention tarihi yoktur. Varsayılan süreyi hiç
tanımlamamak, yeni nesneleri fiziksel WORM koruması dışında bırakabilir.

## Karar

1. İş saklama kararı ile fiziksel Object Lock süresi ayrı alanlardır.
2. İlk üretim döneminde otomatik tasfiye kapalı, tasfiye kimliği yok ve
   uygulama rolünde silme/retention/legal-hold yetkisi bulunmaz.
3. `arsiv-asil` kovasına kurulca onaylanan sonlu bir varsayılan COMPLIANCE
   süresi uygulanır. Sürenin dolması nesnenin silinmesi için yetki veya karar
   oluşturmaz; yalnız yeni bir kurul kararı tasfiye akışını açabilir.
4. Production dağıtımı `ARCHIVE_WORM_RETENTION_DURATION`,
   `ARCHIVE_WORM_POLICY_APPROVED=approved-production-policy` ve
   `ARCHIVE_WORM_POLICY_REFERENCE` olmadan kapanır. Staging örneği olan `1d`
   production'da reddedilir.
5. Karar referansı kurul/tutanak kimliğidir; teknik ekip süre uyduramaz.
   Onaylı süre değişirse yeni referansla değişiklik kaydı oluşturulur. Mevcut
   nesnelerin kilidi kısaltılmaz.

## Sonuç

Bu ayrım ADR-018'in “tasfiye kapalı” amacını korur ve asıl nesnelerin
onaysız bir boşlukta kilitsiz yazılmasını engeller. Üretim süresi hâlâ kurum
girdisidir; sistem bu değer olmadan fail-closed davranır.
