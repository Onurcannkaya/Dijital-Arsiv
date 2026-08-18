# Meclis Belgeleri — Belge Türü Profili Önerisi

**Belge durumu:** Öneri taslağı — Yazı İşleri Müdürlüğü ve arşiv birimi kararı bekliyor
**Sürüm:** 0.1
**Tarih:** 18 Ağustos 2026
**Kapsam:** Belediye Meclisi belgeleri; belge türü profilleri, tespit işaretleri ve alan kümeleri
**Hazırlayan:** Bilgi İşlem (ölçüm ve taslak)
**Karar sahibi:** Yazı İşleri Müdürlüğü (kurumsal veri sahibi), arşiv birimi, Hukuk/KVKK

> Bu belge bir **öneridir**. İçindeki profil kodları, adlar ve tespit işaretleri
> koda tohumlanmamıştır. Sınıflandırma kurumun kararıdır; buradaki katkı yalnız
> gerçek ciltler üzerinde yapılmış ölçüm ve doğrulanmış işaret adaylarıdır.
> `MUDURLUK_BELGE_TURU_ENVANTERI.md` §5'te "Yazı İşleri / Meclis kararı" satırı
> `HYPOTHESIS` olarak zaten duruyor; eksik olan yürürlükteki profildir.

## 1. Neden gerekli

Yürürlükteki altı profil arasında meclis belgesi yok:

| Profil kodu | Ad |
|---|---|
| `TASNIF_BEKLIYOR` | Tasnif bekliyor |
| `ENCUMEN_KARARI` | Encümen karar sureti |
| `ISYERI_ACMA_RUHSATI` | İşyeri açma ruhsatı |
| `NUMARATAJ_TUTANAGI` | Numarataj tespit tutanağı |
| `YANGIN_GUVENLIK_RAPORU` | Yangın güvenlik raporu |
| `YAPI_KULLANMA_IZNI` | Yapı kullanma izin belgesi |

Arşivde ise iki meclis cildi var: `1972 meclis.pdf` (337 sayfa) ve
`2021 1 - 30 Meclis Kararı.pdf` (178 sayfa) — toplam **515 sayfa**.

Bunun bugünkü sonucu ölçüldü. İki meclis belgesi gerçek hattan geçirildi ve
ikisi de tasnif edilmemiş kaldı:

| Belge | Sonuç |
|---|---|
| `karar-b.pdf` (2021 cildi, 5. sayfa) | `tür = Tasnif bekliyor` |
| `meclis-1972-ornek.pdf` (1972 cildi, 2 sayfa) | `profil = TASNIF_BEKLIYOR` |

Profil olmadığı için tür alanı boş kalıyor; boş kalan tür `CRITICAL` risk
üretir ve belge arşivlenemez. Yani meclis belgeleri bugün hattın sonuna kadar
gelip **orada duruyor**.

## 2. Ölçüm: ciltlerde gerçekte ne var

Beklenen "her sayfa bir meclis kararı" değil. İki cilt birbirinden tümüyle
farklı ve **2021 cildi tek başına üç ayrı belge türü** taşıyor.

### 2021 cildi (178 sayfa, 30 karar) — üç tür iç içe

Gerçek başlıklar (metin katmanından, birebir):

1. **Karar** — `T.C. SİVAS BELEDİYE MECLİSİ / Karar No:30 / BELEDİYE MECLİSİNİN
   OCAK AYI TOPLANTISI / 07/01/2021 TARİHLİ BİRLEŞİMDE ALDIĞI KARAR /
   BİRLEŞİME KATILAN ÜYELER:`
2. **Oylama tutanağı** — `T.C. SİVAS BELEDİYE MECLİSİ / MECLİS KARAR OYLAMA
   TUTANAĞI / Karar No :30 / Karar Tarihi :07/01/2021 / Birleşime Katılan Üye
   Sayısı :31`
3. **Komisyon raporu** — `T.C. SİVAS BELEDİYESİ / MECLİS İMAR KOMİSYONU / Sayı
   Konu / MECLİS BAŞKANLIĞINA (KOMİSYON RAPORU)`

Cilt genelinde alan ipuçlarının kaç sayfada geçtiği:

| İpucu | 2021 | 1972 |
|---|---:|---:|
| `KOMİSYON` | 109 | 54 |
| `TOPLANTI` | 95 | 55 |
| ada/parsel | 88 | 5 |
| `GÜNDEM` | 74 | 18 |
| müdürlük adı | 74 | 1 |
| `BİRLEŞİM` | 68 | **0** |
| oybirliği/oyçokluğu | 64 | **0** |
| `Karar No` | 61 | 14 |
| `KATILAN ÜYELER` | 32 | **0** |

### 1972 cildi (337 sayfa) — karar değil, zabıtname

Gerçek OCR çıktısı (2. sayfa):

> `Belediye Meclisinin 11.5.1972 tarihli Olağanüstü toplantisına ait
> Zabitnamedir. MECLISI TESKİL EDENLER : Belediye Başkanı Rahmi Günay'ın
> Başkanlığında; Üyeden: ...`

Bu cilt **toplantı** birimindedir, karar biriminde değil: birleşim, katılan üye
listesi ve oy sonucu alanları hiç yok (yukarıdaki tabloda üçü de 0). Ayrıca
ciltte **başka kurumların evrakı** da bağlı. Aynı örneğin 2. sayfası:

> `T.C. sivas ili Özel İdare Müdürlüğü / No.: 2079 / Tastik olunan belediye
> mechis kararları Hk. / Belediye Başkanlığına`

Yani 1972 cildi için tek bir profil yetmez; ciltte meclis belgesi olmayan
sayfalar da vardır ve bunlar tasnif dışı kalmalıdır.

## 3. Önerilen profiller

| Profil kodu | Ad | Kurumsal sahip | Birim | Durum önerisi |
|---|---|---|---|---|
| `MECLIS_KARARI` | Meclis kararı | Yazı İşleri Müdürlüğü | karar | `HYPOTHESIS` |
| `MECLIS_OYLAMA_TUTANAGI` | Meclis karar oylama tutanağı | Yazı İşleri Müdürlüğü | karar eki | `HYPOTHESIS` |
| `MECLIS_KOMISYON_RAPORU` | Meclis komisyon raporu | Yazı İşleri Müdürlüğü | komisyon | `HYPOTHESIS` |
| `MECLIS_ZABITNAMESI` | Meclis zabıtnamesi (toplantı tutanağı) | Yazı İşleri Müdürlüğü | toplantı | `HYPOTHESIS` |

Dördü ayrı profil olarak öneriliyor çünkü **alan kümeleri farklı**: oylama
tutanağının üye sayıları var ama ada/parseli yok; komisyon raporunun karar
numarası yok, rapor numarası var; zabıtnamenin karar numarası yok, toplantı
tarihi ve türü var. Tek profile sıkıştırılırsa her belgede alanların büyük
bölümü "bulunamadı" olarak personel girişine düşer.

Alternatif: tek `MECLIS_BELGESI` profili + alt tür alanı. Bu, alan
zorunluluklarını belge başına ayrıştıramaz; öneri dört profildir ama karar
kuruma aittir.

## 4. Tespit işaretleri — ölçülerek seçildi

İşaretler gerçek başlıklara karşı, uygulamanın **kendi eşleştiricisiyle**
denendi. Eşleştirme ASCII katlaması üzerinde ve kelime öneki olarak çalışır;
`MECLİSİ`, `MECLISI` ve `Meclisinin` biçimleri tek `MECLİS` jetonuyla
karşılanır.

| Profil | Önerilen işaret(ler) |
|---|---|
| `MECLIS_KARARI` | `BİRLEŞİMDE ALDIĞI KARAR`, `MECLİS KARARI` |
| `MECLIS_OYLAMA_TUTANAGI` | `MECLİS KARAR OYLAMA TUTANAĞI` |
| `MECLIS_KOMISYON_RAPORU` | `MECLİS KOMİSYONU` |
| `MECLIS_ZABITNAMESI` | `MECLİS ZABITNAME` |

### Ölçüm sonucu

Kapsama (sayfa sayısı; 1972'de gömülü metin katmanı bozuk olduğu için o
sütun **alt sınırdır** — gerçek OCR'da aynı cildin örnek sayfası
`MECLIS_ZABITNAMESI` olarak tespit edildi):

| Profil | 2021 cildi (178 s.) | 1972 cildi (337 s.) |
|---|---:|---:|
| `MECLIS_KOMISYON_RAPORU` | 49 | 14 |
| `MECLIS_KARARI` | 39 | 21 |
| `MECLIS_OYLAMA_TUTANAGI` | 29 | 0 |
| `MECLIS_ZABITNAMESI` | 0 | 9 |
| tespit yok | 60 | 290 |

Yanlış pozitif denetimi — encümen ciltlerinin ilk 200 sayfası hiçbir meclis
profiline **kaymadı** (2021 Encümen: 0, 2019 Encümen: 0).

### Reddedilen aday: `KOMİSYON RAPORU`

İlk denemede komisyon raporu işareti `KOMİSYON RAPORU` idi ve 2021 encümen
cildinin **12 sayfasını** çaldı: kurumda birden çok komisyon var ve o sayfalar
`MİMARİ ESTETİK KOMİSYONU / KOMİSYON RAPORU` başlığını taşıyor. İşaret
`MECLİS KOMİSYONU` olarak sıkılaştırıldığında kayma sıfıra indi. **Bu, işaret
seçiminin ölçülmeden yapılamayacağının kanıtıdır**; kurum işaretleri
değiştirdiğinde aynı denetimin yeniden koşturulması önerilir.

### Bilinen sınır

2021 cildinde 1, 1972 cildinde 3 sayfa `ENCUMEN_KARARI` olarak tespit edildi:
gövdesinde encümen kararına atıf yapan meclis sayfaları. Tespit başlığı
gövdeye tercih eder ama başlıkta hiç işaret yoksa gövdeye düşer. Tür alanı
`VERIFY_REQUIRED` olduğundan memur onayı olmadan arşive girmez.

## 5. Alan önerileri

Ortak çekirdek (bütün profillerde): `document_type`, `unit`, `document_date`,
`document_number`, `neighborhood`, `ada`, `parcel`, `addressee`.

| Profil | Zorunlu (arşivleme öncesi) | Kritik | Öneri olarak çıkarılacak |
|---|---|---|---|
| `MECLIS_KARARI` | document_date, document_number | document_type, unit, document_date | ada, parcel, neighborhood, subject |
| `MECLIS_OYLAMA_TUTANAGI` | document_date, document_number | document_type, unit | katılan/katılmayan üye sayısı, oy sonucu |
| `MECLIS_KOMISYON_RAPORU` | document_date | document_type, unit | komisyon adı, rapor sayısı, havale tarihi, ada, parcel |
| `MECLIS_ZABITNAMESI` | document_date | document_type, unit | toplantı türü (olağan/olağanüstü), toplantı tarihi |

2021 cildinde ada/parsel 88 sayfada geçiyor: meclis kararlarının önemli bölümü
imar konulu ve mevcut ada/parsel çıkarımı bu profillerde de değerlidir.

### Veri sözlüğü gerektiren yeni alanlar

Aşağıdaki alan kodları `VERI_SOZLUGU.md`'de **tanımlı değil**; profile
eklenmeden önce sözlüğe girmeleri gerekir. Kod ve iş adı önerisi:

| İş adı | Önerilen kod | Tip/çokluk | Nerede geçiyor |
|---|---|---|---|
| Oy sonucu | `vote_outcome` | Kod/tek | 2021 cildi, 64 sayfa |
| Birleşim tarihi | `session_date` | Tarih/tek | 2021 cildi, 68 sayfa |
| Katılan üye sayısı | `attending_member_count` | Sayı/tek | oylama tutanağı |
| Katılmayan üye sayısı | `absent_member_count` | Sayı/tek | oylama tutanağı |
| Komisyon adı | `commission_name` | Metin/tek | 2021 cildi, 109 sayfa |
| Toplantı türü | `meeting_kind` | Kod/tek | 1972 cildi (olağan/olağanüstü) |

`Konu` alanı sözlükte `subject` olarak zaten tanımlı; gündem maddesi için
ayrı bir kod önerilmiyor.

## 6. Kurumun karar vermesi gereken noktalar

1. Dört ayrı profil mi, tek profil + alt tür mü?
2. Oylama tutanağı ve komisyon raporu **ayrı belge** mi, kararın **eki** mi
   sayılacak? Ek sayılırsa ilişki modeli (belge-belge bağı) gerekir.
3. Karar numarası hangi profillerde arşivleme öncesi zorunlu olacak?
4. 1972 cildindeki başka kurum evrakı nasıl tasnif edilecek — kendi türüyle
   mi, "tasnif dışı" olarak mı?
5. Zabıtname karar birimine bölünecek mi? (Bölme kararı
   `ADR-019-TOPLU-TARAMA-KARAR-BOLME.md` kapsamındadır.)
6. Dosya planı kodu ve saklama kuralı her profil için ne olacak?

## 7. Onay ve sonraki adım

`MUDURLUK_BELGE_TURU_ENVANTERI.md` §9'daki profil onay koşulları geçerlidir.
Bu öneri onaylanırsa yapılacak iş küçüktür: `lib/archive-seed.ts` içindeki
`seedDocumentTypes` listesine dört kayıt eklenir, gereken alan kodları veri
sözlüğüne ve çekirdeğe girer, şema sürümü artırılır. Onay öncesi hiçbir kod
değişikliği yapılmadı.

Onaydan sonra §4'teki kapsama ve yanlış pozitif denetiminin, gerçek OCR
metniyle ve daha geniş örnekle yeniden koşturulması önerilir; buradaki 1972
sayıları gömülü metin katmanından geldiği için alt sınırdır.
