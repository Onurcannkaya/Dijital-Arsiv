# Sivas Belediyesi Dijital Arşiv — Veri Sözlüğü

**Belge durumu:** Mantıksal veri sözlüğü taslağı — kurumsal doğrulama bekliyor  
**Sürüm:** 0.1  
**Tarih:** 29 Temmuz 2026  
**Kapsam:** Belge, dosya, OCR, ortak varlık, ilişki, iş akışı ve denetim verileri

> Bu sözlük fiziksel veritabanı şeması değildir. İş anlamını ve veri sözleşmesini tanımlar; tablo ve kolon tasarımı bu sözlüğe göre ayrıca sürümlenir.

## 1. Amaç

Veri sözlüğü; kullanıcı ekranı, veritabanı, OCR servisi, arama dizini ve entegrasyonların aynı kavramları aynı anlamda kullanmasını sağlar. Bir alanın yalnız teknik adını değil, kurumsal sahibini, yetkili kaynağını, doğrulama ve gizlilik kurallarını da tanımlar.

## 2. Alan tanımı standardı

Her yeni alan aşağıdaki bilgilerle kaydedilir:

| Özellik | Açıklama |
|---|---|
| İş adı | Kullanıcıların gördüğü Türkçe ad |
| Teknik ad | API ve veri modelindeki kararlı ad |
| Tanım | Alanın iş anlamı |
| Veri tipi | Metin, tarih, kimlik, sayı, geometri, kod, JSON vb. |
| Çokluk | Tek değer veya çoklu değer |
| Zorunluluk | Zorunlu, koşullu veya isteğe bağlı |
| Yetkili kaynak | Alanı belirleyen sistem veya birim |
| Doğrulama | Biçim, sözlük ve çapraz alan kuralları |
| Gizlilik | Açık, kurum içi, kişisel, özel nitelikli veya kısıtlı |
| Arama kullanımı | Tam metin, filtre, sıralama veya arama dışı |
| OCR politikası | Çıkarılmaz, önerilir, kritik/onaylı |
| Kurumsal sahip | Anlam ve kalite kararını veren rol/birim |
| Geçerlilik | Başlangıç/bitiş ve sözlük sürümü |
| Örnek | Kişisel veri içermeyen örnek değer |

## 3. Adlandırma ve genel kurallar

- Teknik adlar İngilizce `snake_case` kullanır.
- Kimlikler kullanıcıya görünen numaralardan ayrılır.
- Ada, parsel, kapı numarası ve resmî sayı gibi değerler baştaki sıfır veya hukuki ek kaybını önlemek için metin olarak saklanır.
- Tarihler ISO 8601 biçiminde; kullanıcıya yerel biçimde gösterilir.
- Zaman damgaları saat dilimi bilgisiyle saklanır.
- Boş değer ile “bilinmiyor”, “uygulanamaz” ve “belirlenmedi” aynı anlamda kullanılmaz.
- Yetkili kaynaktan gelen değer ile OCR önerisi aynı alana sessizce yazılmaz; kaynak ve doğrulama durumu korunur.
- Kontrollü listeler kod, görünen ad, sürüm, geçerlilik tarihi ve sahip taşır.
- Kişisel veri nesne anahtarına, dosya adına veya log mesajına yazılmaz.

## 4. Veri sınıfları

| Kod | Sınıf | Örnek | Varsayılan davranış |
|---|---|---|---|
| `PUBLIC` | Açık | Kamuya açık karar referansı | Kurumsal yayın kararı ayrıca gerekir |
| `INTERNAL` | Kurum içi | İş akışı durumu | Kimliği doğrulanmış kullanıcı |
| `PERSONAL` | Kişisel veri | Ad, iletişim, kimlik bilgisi | Amaç ve rol bazlı erişim |
| `SENSITIVE` | Özel nitelikli/kritik | Özel nitelikli kişisel veri | Güçlü kısıtlama ve ayrı denetim |
| `RESTRICTED` | Kurumsal kısıtlı | Soruşturma, güvenlik veya gizli işlem | Açık yetki ve gerekçe |

Kesin sınıflandırma hukuk/KVKK ve bilgi güvenliği tarafından onaylanır.

## 5. Belge çekirdeği

| İş adı | Teknik ad | Tip/çokluk | Zorunluluk | Yetkili kaynak | Temel kural |
|---|---|---|---|---|---|
| Belge kimliği | `document_id` | UUID/tek | Zorunlu | Arşiv sistemi | Değişmez iç kimlik |
| Arşiv referans numarası | `archive_reference_no` | Metin/tek | Zorunlu | Arşiv sistemi | Kurum genelinde benzersiz |
| Kaynak sistem | `source_system` | Kod/tek | Zorunlu | Entegrasyon kaydı | Web, mobil, EBYS, toplu aktarım vb. |
| Kaynak kayıt kimliği | `source_record_id` | Metin/tek | Koşullu | Kaynak sistem | Kaynak sistemle birlikte benzersiz |
| Belge türü | `document_type_id` | Kimlik/tek | Zorunlu | Belge türü sözlüğü | Sürümlü profile bağlanır |
| Profil sürümü | `document_profile_version` | Metin/tek | Zorunlu | Arşiv sistemi | Doğrulamada kullanılan profil |
| Sorumlu müdürlük | `owning_department_id` | Kimlik/tek | Zorunlu | Teşkilat sözlüğü | Belgenin kurumsal sahibi |
| Belge tarihi | `document_date` | Tarih/tek | Koşullu | Belge/EBYS | Kritik alan; politika gereği onay |
| Belge sayısı | `document_number` | Metin/tek | Koşullu | Belge/EBYS | Biçim belge türüne bağlı |
| Konu | `subject` | Metin/tek | Koşullu | Belge/personel | Tam metinden ayrı üst veri |
| Durum | `document_status` | Kod/tek | Zorunlu | İş akışı | Kontrollü durum sözlüğü |
| Dosya planı kodu | `file_plan_code` | Kod/tek | Arşivlemede zorunlu | Yetkili dosya planı | Sürümüyle saklanır |
| Saklama kuralı | `retention_rule_id` | Kimlik/tek | Arşivlemede zorunlu | Arşiv birimi | Başlangıç olayı ve karar içerir |
| Erişim sınıfı | `access_class` | Kod/tek | Zorunlu | Veri sahibi/Hukuk | En az ayrıcalık |
| Kabul zamanı | `ingested_at` | Zaman/tek | Zorunlu | Arşiv sistemi | Değiştirilemez olayla bağlı |
| Yükleyen aktör | `ingested_by` | Kimlik/tek | Zorunlu | Kimlik sistemi | Kullanıcı veya servis hesabı |

## 6. Belge türü ve alan profili

| İş adı | Teknik ad | Tip | Kural |
|---|---|---|---|
| Belge türü kimliği | `document_type_id` | UUID | Değişmez iç kimlik |
| Belge türü kodu | `document_type_code` | Kod | Kurum genelinde benzersiz |
| Belge türü adı | `document_type_name` | Metin | Türkçe görünen ad |
| Kurumsal sahip | `owner_department_id` | Kimlik | Alan kurallarını onaylayan müdürlük |
| Profil sürümü | `profile_version` | Metin | Semantik veya kurumca kararlaştırılan sürüm |
| Geçerlilik başlangıcı | `valid_from` | Tarih | Yeni belgelerde kullanılmaya başlandığı tarih |
| Geçerlilik sonu | `valid_to` | Tarih | Eski profili silmeden kapatır |
| Alan kimliği | `field_definition_id` | UUID | Alan tanımına değişmez bağ |
| Alan kodu | `field_code` | Kod | Profil içinde benzersiz |
| Veri tipi | `data_type` | Kod | Metin, tarih, kimlik, varlık ilişkisi vb. |
| Çokluk | `cardinality` | Kod | `one`, `zero_or_one`, `one_or_more`, `many` |
| Zorunluluk kuralı | `required_rule` | İfade | Koşullu kuralları destekler |
| Kritik alan | `is_critical` | Boolean | Onay politikasını etkiler |
| OCR politikası | `extraction_policy` | Kod | Çıkarılmaz, önerilir, doğrulama zorunlu |
| Sözlük bağlantısı | `vocabulary_id` | Kimlik | Varsa yetkili kontrollü liste |

Müdürlüğe özel alanlar doğrudan belge tablosuna yeni kolon eklemek yerine bu profillerle tanımlanır; yüksek hacimli ve ortak alanlar performans için fiziksel modelde ayrıca optimize edilebilir.

## 7. Dosya ve nesne kayıtları

| İş adı | Teknik ad | Tip | Zorunluluk | Kural |
|---|---|---|---|---|
| Nesne kaydı kimliği | `binary_object_id` | UUID | Zorunlu | Veritabanı kimliği |
| Belge kimliği | `document_id` | UUID | Zorunlu | Üst belge |
| Nesne sınıfı | `object_class` | Kod | Zorunlu | Asıl, OCR, erişim, koruma, küçük resim |
| Depolama anahtarı | `object_key` | Metin | Zorunlu | PII içermez, benzersiz |
| Depolama sürümü | `storage_version_id` | Metin | Koşullu | Sağlayıcı sürüm kimliği |
| Medya türü | `media_type` | Metin | Zorunlu | Doğrulanmış MIME |
| Dosya boyutu | `byte_size` | Tamsayı | Zorunlu | Depolama sonucu ile doğrulanır |
| SHA-256 | `sha256` | Metin | Zorunlu | Uygulama tarafından hesaplanır |
| Şifreleme durumu | `encryption_status` | Kod | Zorunlu | Anahtar kimliği loga açık yazılmaz |
| Oluşturma zamanı | `created_at` | Zaman | Zorunlu | Değiştirilemez olayla bağlı |
| Kaynak nesne | `derived_from_id` | UUID | Türevde zorunlu | Asıl veya önceki türeve bağ |
| Üretim aracı | `generator` | Metin | Türevde zorunlu | Yazılım/model ve sürüm |

## 8. OCR ve alan kanıtı

| İş adı | Teknik ad | Tip | Kural |
|---|---|---|---|
| Çıkarım kimliği | `extracted_value_id` | UUID | Her öneri için ayrı kayıt |
| Belge kimliği | `document_id` | UUID | Zorunlu |
| Alan tanımı | `field_definition_id` | UUID | Zorunlu |
| Ham değer | `raw_value` | Metin/JSON | Modelin ürettiği değer |
| Normalize değer | `normalized_value` | Metin/JSON | Kurala göre normalize edilmiş değer |
| Onaylı değer | `confirmed_value` | Metin/JSON | İnsan veya yetkili kaynak doğrulaması |
| Güven | `confidence` | Ondalık | 0–1; model güveni, risk skoru değildir |
| Risk seviyesi | `risk_level` | Kod | İş kuralı ve tutarlılık değerlendirmesi |
| Sayfa | `page_number` | Tamsayı | 1’den başlayan sayfa |
| Kanıt kutusu | `evidence_bbox` | JSON | Sayfa koordinat sistemine göre |
| Kanıt metni | `evidence_text` | Metin | Sınırlı bağlam |
| Model | `model_id` | Metin | Ad ve sürüm |
| Sözlük sürümü | `vocabulary_version` | Metin | Uygulandıysa |
| Doğrulama durumu | `verification_status` | Kod | Öneri, onaylı, reddedildi, düzeltildi |
| Doğrulayan | `verified_by` | Kimlik | İnsan onayında zorunlu |
| Doğrulama zamanı | `verified_at` | Zaman | İnsan onayında zorunlu |

Aynı belge ve alan için birden fazla değer bulunabilir. Özellikle parsel, adres, kişi ve kurum alanlarında tek değer varsayımı yapılmaz.

## 9. Ortak varlık çekirdeği

| İş adı | Teknik ad | Tip | Kural |
|---|---|---|---|
| Varlık kimliği | `entity_id` | UUID | Arşiv içi değişmez kimlik |
| Varlık türü | `entity_type` | Kod | Adres, parsel, yapı, kişi, kurum vb. |
| Görünen ad | `display_label` | Metin | Arayüz için, entegrasyon anahtarı değildir |
| Kaynak sistem | `authority_source` | Kod | CBS, personel, arşiv vb. |
| Dış kimlik | `external_id` | Metin | Kaynak sistemle birlikte benzersiz |
| Geçerlilik başlangıcı | `valid_from` | Tarih | Varsa |
| Geçerlilik sonu | `valid_to` | Tarih | Eski kaydı silmeden kapatır |
| Durum | `entity_status` | Kod | Aktif, tarihsel, birleştirildi vb. |

### 9.1 Parsel

| İş adı | Teknik ad | Tip | Yetkili kaynak/Kural |
|---|---|---|---|
| CBS parsel kimliği | `parcel_external_id` | Metin | Kent Rehberi/CBS; tercih edilen entegrasyon anahtarı |
| İlçe | `district_id` | Kimlik | Yetkili idari birim sözlüğü |
| Kadastro mahallesi | `cadastral_neighborhood_id` | Kimlik | CBS/kadastro sözlüğü |
| Ada | `block_no` | Metin | Ek ve baştaki sıfırlar korunur |
| Parsel | `parcel_no` | Metin | `12-A`, `3/1` gibi değerler korunur |
| Geometri | `geometry` | Geometri | CBS; sürüm/tarih bilgisiyle |
| Geometri sürümü | `geometry_version` | Metin | CBS güncellemesiyle eşleştirme |
| Durum | `parcel_status` | Kod | Güncel, tarihsel, bölündü, birleşti vb. |

### 9.2 Adres

| İş adı | Teknik ad | Tip | Yetkili kaynak/Kural |
|---|---|---|---|
| CBS adres kimliği | `address_external_id` | Metin | Kent Rehberi/CBS |
| Yetkili ulusal kimlik | `national_address_id` | Metin | Kurum kullanıyorsa; karar bekliyor |
| Mahalle | `neighborhood_id` | Kimlik | Yetkili adres sözlüğü |
| Yol | `street_id` | Kimlik | Yetkili adres/CBS kaynağı |
| Dış kapı | `door_no` | Metin | Ekler korunur |
| İç kapı | `unit_no` | Metin | Varsa |
| Normalize adres | `normalized_address` | Metin | Arama/görüntüleme için |
| Tarihsel yazım | `historical_address_text` | Metin/çoklu | Belgedeki özgün ifade korunur |
| Konum | `point_geometry` | Geometri | Varsa CBS |

### 9.3 Yapı ve bağımsız bölüm

| İş adı | Teknik ad | Tip | Kural |
|---|---|---|---|
| CBS yapı kimliği | `building_external_id` | Metin | Yetkili CBS anahtarı |
| Yapı etiketi | `building_label` | Metin | Kullanıcıya gösterim |
| Ana parsel ilişkisi | `parcel_entity_id` | UUID/çoklu | Tarihsel geçerlilikle |
| Yapı geometrisi | `building_geometry` | Geometri | Varsa CBS |
| Bağımsız bölüm kimliği | `unit_external_id` | Metin | Yetkili kaynak varsa |
| Bağımsız bölüm numarası | `unit_label` | Metin | Görünen değer |

Kişi ve kurum alanlarının ayrıntılı veri sınıfları hukuk/KVKK envanteriyle tamamlanacaktır.

## 10. Belge-varlık ilişkisi

| İş adı | Teknik ad | Tip | Kural |
|---|---|---|---|
| İlişki kimliği | `document_entity_relation_id` | UUID | Değişmez |
| Belge | `document_id` | UUID | Zorunlu |
| Varlık | `entity_id` | UUID | Zorunlu |
| İlişki türü | `relation_type` | Kod | Kontrollü sözlük |
| Kaynak | `relation_source` | Kod | CBS, insan, OCR, entegrasyon, mekânsal |
| Güven | `relation_confidence` | Ondalık | Otomatik ilişkide |
| Doğrulama durumu | `verification_status` | Kod | Öneri/onaylı/reddedildi |
| Geçerlilik başlangıcı | `valid_from` | Tarih | Varsa |
| Geçerlilik sonu | `valid_to` | Tarih | Varsa |
| Kanıt | `evidence_reference` | JSON | Sayfa, kutu, metin veya CBS olayı |
| Onaylayan | `verified_by` | Kimlik | İnsan onayında |

Başlangıç ilişki türleri:

| Kod | Anlam |
|---|---|
| `SUBJECT` | Belgenin ana konusu |
| `AFFECTS` | Belgenin etkilediği varlık |
| `ATTACHMENT_REFERENCE` | Ek veya listede geçen |
| `NEIGHBOR` | Komşu varlık olarak geçen |
| `PARTY` | Belgenin tarafı |
| `HISTORICAL_LINK` | Eski/yeni varlık bağlantısı |
| `SPATIAL_INTERSECTION` | Geometri kesişimiyle önerilen |
| `TEXT_MENTION` | Yalnız OCR/tam metin içinde geçen |

`TEXT_MENTION` ve `SPATIAL_INTERSECTION` varsayılan olarak doğrulanmış hukuki ilişki sayılmaz.

## 11. Parsel soy ilişkisi

| İş adı | Teknik ad | Tip | Kural |
|---|---|---|---|
| Soy ilişkisi kimliği | `parcel_lineage_id` | UUID | Değişmez |
| Önceki parsel | `predecessor_parcel_id` | UUID | Zorunlu |
| Sonraki parsel | `successor_parcel_id` | UUID | Zorunlu |
| Olay türü | `lineage_event_type` | Kod | İfraz, tevhit, düzeltme vb. |
| Olay tarihi | `event_date` | Tarih | Varsa |
| Kaynak kayıt | `source_reference` | Metin | CBS/kadastro/karar kaydı |
| Doğrulama durumu | `verification_status` | Kod | Yetkili kaynak veya personel |

Başlangıç olay türleri `SUBDIVISION`, `MERGE`, `RENUMBER`, `BOUNDARY_CORRECTION` ve `OTHER` olarak önerilir; CBS birimi tarafından doğrulanır.

## 12. İş akışı ve denetim

### 12.1 Belge durumları

| Kod | Anlam |
|---|---|
| `RECEIVED` | Dosya alındı, kabul tamamlanmadı |
| `QUARANTINED` | Güvenlik veya biçim incelemesinde |
| `QUEUED` | İşlem kuyruğunda |
| `PROCESSING` | OCR/AI çalışıyor |
| `REVIEW` | İnsan doğrulaması bekliyor |
| `READY` | Üst veri tamam, arşivleme bekliyor |
| `ARCHIVED` | Arşiv kaydı ve erişim politikası etkin |
| `RETENTION_REVIEW` | Saklama/tasfiye incelemesinde |
| `TRANSFERRED` | Yetkili kuruma devredildi |
| `DISPOSED` | Onaylı imha tamamlandı |

### 12.2 Denetim olayı

| İş adı | Teknik ad | Kural |
|---|---|---|
| Olay kimliği | `audit_event_id` | Değişmez |
| Belge/nesne bağlamı | `subject_reference` | İlgili kayıt |
| Aktör | `actor_id` | Kullanıcı veya servis |
| Eylem | `action_code` | Kontrollü sözlük |
| Zaman | `occurred_at` | Saat dilimli |
| Amaç/gerekçe | `purpose_code` | Gereken işlemlerde zorunlu |
| Önceki durum özeti | `before_hash` | Uygun olaylarda |
| Sonraki durum özeti | `after_hash` | Uygun olaylarda |
| Zincir değeri | `event_hash` | Bütünlük kanıtı |

Görüntüleme, indirme, dışa aktarım, düzeltme, ilişki onayı, yetki değişikliği ve tasfiye kararları denetlenir.

## 13. Kontrollü sözlükler

İlk sürümde en az aşağıdaki sözlükler yönetilir:

- Müdürlük ve organizasyon birimleri
- Belge türleri ve profil sürümleri
- Alan tanımları
- Mahalle ve kadastro mahalleleri
- Belge-varlık ilişki türleri
- Veri sınıfları ve erişim sınıfları
- Belge durumları
- Dosya planı kodları
- Saklama kuralları ve tasfiye kararları
- OCR/model ve kurumsal sözlük sürümleri
- Denetim eylem kodları

Her sözlük kaydı `code`, `label`, `version`, `valid_from`, `valid_to`, `owner` ve `source` bilgilerini taşır.

## 14. Veri sahipliği ve yetkili kaynak matrisi

| Veri alanı | Önerilen yetkili kaynak | Kurumsal onay sahibi |
|---|---|---|
| Parsel, adres, yapı kimliği/geometrisi | Kent Rehberi/CBS | CBS birimi |
| Müdürlük ve kullanıcı birimi | Personel/kimlik sistemi | İnsan kaynakları/bilgi işlem |
| Belge türü ve zorunlu alanlar | İlgili müdürlük + arşiv | Müdürlük veri sorumlusu |
| Dosya planı ve saklama | Yetkili kurumsal plan | Arşiv birimi |
| Veri sınıfı ve paylaşım | KVKK/veri envanteri | Hukuk/KVKK |
| Asıl dosya özeti | Arşiv kabul servisi | Bilgi işlem/arşiv |
| OCR önerisi ve güveni | OCR/AI servisi | Teknik model sahibi |
| Onaylı alan değeri | Yetkili doğrulayıcı | İlgili müdürlük/arşiv |

Bu matris kurum tarafından isim ve görevlerle tamamlanır.

## 15. Değişiklik ve sürüm yönetimi

1. Yeni alan talebi iş tanımı ve sahibiyle açılır.
2. Mevcut ortak alanla karşılanıp karşılanmadığı kontrol edilir.
3. Veri tipi, çokluk, gizlilik, doğrulama ve entegrasyon etkisi değerlendirilir.
4. İlgili müdürlük, arşiv, hukuk/KVKK ve bilgi işlem gereken kapsamda onay verir.
5. Profil veya sözlük yeni sürümle yayımlanır.
6. Eski kayıtlar sessizce dönüştürülmez; göç kuralı ve denetim kaydı oluşturulur.
7. API, arama ve OCR etkileri test edilir.

## 16. Açık kararlar

- Kurumsal veri sınıflarının kesin adları ve paylaşım kuralları
- CBS dış kimliklerinin alan adları ve değişmezlik garantisi
- Ulusal adres kimliğinin kurum içindeki kullanımı
- Geometri koordinat referans sistemi
- Kişi/kurum tekilleştirme politikası
- Belge türü profil sürümleme yöntemi
- Saklama başlangıç olayları ve yetkili karar sahipleri
- Arama dizinine aktarılmayacak hassas alanlar

