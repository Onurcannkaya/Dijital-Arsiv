# Sivas Belediyesi Dijital Arşiv — Tasarım Sistemi ve Ekran Şartnamesi

**Kaynak tasarım:** `Dijital Arsiv.dc.html` (seçenekler 1a, 1b, 2a, 2b)
**Durum:** Uygulanabilir tasarım kararları — kurumsal onay bekliyor
**Kapsam:** Belge Doğrulama ekranı ve türetilecek tüm arşiv ekranları için ortak dil
**Tavsiye edilen temel:** `2a` (doğrulama) + `2b` (ilişkiler ve geçmiş)

---

## 1. Tasarım ilkeleri

1. **Asıl dosya kutsaldır.** Arayüz hiçbir yerde asıl taramayı değiştirdiği izlenimi vermez. Düzeltmeler ayrı bir katmanda birikir; her ekranda "asıl dosya değişmez" ifadesi görünür bir yerde durur.
2. **Ekran tek bir soru sorar.** Personelden ne beklendiği ilk bakışta okunur: "İki alanı onaylamanız gerekiyor." Makinenin doğru okuduğu alanlar katlanır, öne çıkmaz.
3. **Kanıt olmadan iddia yok.** Her makine çıkarımı, belgedeki yerine bağlanabilir (kanıt kırpması + belge üzerinde vurgu). Kanıtı gösterilemeyen değer "öneri" olarak kalır, resmî bağ kurmaz.
4. **Güven, sayı değil eylemdir.** Personele `%41` gösterilmez; "belgede elle yazılmış, bilgisayar emin değil, kontrol edin" gösterilir. Yüzdeler yalnızca yönetici/denetim ekranlarında ve API'de kalır.
5. **Kırmızı bir vurgu rengi değildir.** Yalnızca eksik zorunlu alan, karantina ve hata için. Kurumsal vurgu altındır, birincil eylem lacivert.
6. **Zorunlu alan tamamlanmadan arşivleme kilitli.** Devre dışı buton yalnız başına yeterli değil; nedeni yanında yazılır.
7. **Kişisel veri varsayılan olarak gizlidir.** Açma işlemi bir amaç kaydı gerektirir.

---

## 2. Tasarım tokenları

### 2.1 Renk

Palet kurumsal logodan türetilmiştir (lacivert + altın), kırmızı yalnız durum rengi olarak korunur.

| Token | Değer | Kullanım |
|---|---|---|
| `--navy-900` | `#0B2450` | Üst bar / koyu yüzey (yoğun düzenler) |
| `--navy-800` | `#0E2A5C` | Birincil eylem, aktif sekme çizgisi, koyu panel |
| `--navy-700` | `#1C3F73` | Koyu yüzey üzerinde ikincil dolgu, avatar |
| `--navy-300` | `#93A6C4` | Koyu yüzey üzerinde ikincil metin |
| `--navy-200` | `#B3C2DA` | Koyu yüzey üzerinde üçüncül metin |
| `--navy-100` | `#D2DCEC` | Koyu yüzey üzerinde vurgulu metin |
| `--navy-050` | `#E7EDF7` | Koyu yüzey üzerinde birincil metin |
| `--gold-600` | `#A98351` | Kurumsal vurgu: aktif kanıt çerçevesi, ikincil eylem |
| `--gold-700` | `#8A6A3B` | Sorgu dili anahtar kelimeleri (`mahalle:`, `ada:`) |
| `--amber-600` | `#C98A16` | Dikkat: düşük güven, onay bekliyor, uyarı ikonu |
| `--amber-050` | `#FDFAF3` | Dikkat kart zemini |
| `--amber-100` | `#EADFCB` | Dikkat kart kenarı |
| `--amber-900` | `#7A5310` | Dikkat metni (koyu) |
| `--red-600` | `#A32027` | Kritik: eksik zorunlu alan, karantina, reddedilen erişim |
| `--red-800` | `#8A1A20` | Kritik metin |
| `--red-050` | `#FDF6F6` | Kritik kart zemini |
| `--red-100` | `#E8C4C6` | Kritik kart kenarı |
| `--green-600` | `#3E8459` | Onaylandı, bütünlük tamam |
| `--green-700` | `#2F6B45` | Onay metni |
| `--green-050` | `#F6FAF7` | Onay kart zemini |
| `--green-100` | `#D5E0D8` | Onay kart kenarı |
| `--surface-page` | `#F4F3F0` | Uygulama zemini |
| `--surface-card` | `#FFFFFF` | Kart / panel |
| `--surface-sunken` | `#E8E6E0` | Belge görüntüleyici zemini |
| `--surface-muted` | `#FAF9F7` | Katlanmış / ikincil blok |
| `--border-strong` | `#DCD8D0` | Buton ve giriş kenarı |
| `--border-base` | `#E4E1DA` | Kart ve bölme kenarı |
| `--border-subtle` | `#EDEBE5` | Satır ayırıcı |
| `--text-primary` | `#1B1F26` | Ana metin |
| `--text-secondary` | `#6A6F78` | Açıklama, etiket |
| `--text-disabled` | `#9AA0A8` | Devre dışı, placeholder |
| `--disabled-fill` | `#E6E3DC` | Devre dışı buton zemini |

**Kural:** Bir ekranda en fazla iki durum rengi aynı anda baskın olabilir. Belge görüntüleyicide aynı anda **yalnızca bir** aktif kanıt vurgusu bulunur (`--gold-600`).

### 2.2 Tipografi

Aile: `"IBM Plex Sans"` (arayüz), `"IBM Plex Mono"` (referans no, kimlik, ada/parsel, karar no değeri, karma/zaman).
Yükleme: Google Fonts, ağırlıklar 400 / 500 / 600 / 700.

| Rol | Boyut / satır | Ağırlık |
|---|---|---|
| Ekran başlığı | 14px / 1.2 | 600 |
| Bölüm başlığı (kart) | 15px / 1.35 | 600 |
| Görev başlığı ("İki alanı onaylamanız gerekiyor") | 17px / 1.35 | 600 |
| Alan adı | 13.5–14px / 1.3 | 600 |
| Gövde / açıklama | 12.5px / 1.6 | 400 |
| Satır değeri | 12.5–13px / 1.45 | 500 |
| Etiket / meta | 12px / 1.4 | 400 |
| Sekme | 13px / 1 | 400 (aktif 600) |
| Buton | 12.5–13.5px / 1 | 500 (birincil 600) |
| Rozet | 11px / 1 | 500–600 |
| Kanıt etiketi (belge üzeri) | 11px / 1 | 600 |
| Referans no (mono) | 11.5px | 400 |
| Onaylanacak değer girişi (mono) | 15px | 500 |

**Alt sınır:** Personel arayüzünde 12px altı metin kullanılmaz. Yoğun yönetici tablolarında istisnai olarak 11px.

### 2.3 Ölçü ve boşluk

- Boşluk skalası: `4 · 6 · 8 · 10 · 14 · 16 · 20 · 22 · 26 · 30`
- Köşe yarıçapı: rozet `3px`, giriş/buton `6px`, kart `7–8px`, avatar `50%`
- Kenarlık: `1px` standart, `1.5–2px` aktif/kritik durumda
- Gölge: kart `0 2px 8px rgba(0,0,0,.07)`, belge sayfası `0 2px 12px rgba(0,0,0,.12)`
- Yükseklikler: üst bar `62px`, sekme şeridi `46px`, buton `36px` (üst bar) / `40–42px` (form), giriş `40px`, ikincil buton `30–32px`
- Sağ panel genişliği: `452px` (2a). Belge sayfası genişliği: `560px`
- **Sıralı grup düzeni her zaman flex/grid + `gap`** ile kurulur; boşluk için margin veya boş metin düğümü kullanılmaz.

---

## 3. Bileşenler

### 3.1 Üst bar
Logo (32px, daire, `object-fit: cover`) → ekran adı + belge kimliği (iki satır) → esneyen boşluk → ilerleme metni ("14 belgeden 3.'ü") → dikey ayırıcı → ikincil eylem ("Sonra bak") → birincil eylem ("Sıradaki belge", lacivert).

### 3.2 Sekme şeridi
Beyaz zemin, alt kenarlık `--border-base`. Aktif sekme: `box-shadow: inset 0 -2px 0 var(--navy-800)`, ağırlık 600. Sayaç rozeti aktifken lacivert dolgu/beyaz metin, pasifken `#F0EEE9` dolgu/ikincil metin.
Sekmeler: **Belge ve alanlar · İlişkiler ve geçmiş (n) · İşlem kayıtları**

### 3.3 Belge görüntüleyici
Zemin `--surface-sunken`; üstte hafif bir araç satırı (sayfa göstergesi, yönlendirme metni, "Büyüt"). Sayfa beyaz, gölgeli, `align-self: flex-start`, dikey kaydırma taşan içerikte.
**Kanıt vurgusu:** `position: absolute` yüzdelik kutu, `2px solid var(--gold-600)`, `background: rgba(169,131,81,.14)`, hemen bitişiğinde altın dolgulu ad etiketi (yalnızca alan adı — yüzde yok). Aynı anda tek vurgu.
**Kanıt kırpması:** ayrı `<img>` yerine `background: url(...) -Xpx -Ypx / Wpx auto no-repeat` ile piksel tabanlı konumlandırma; yükseklik `66px`, `role="img"` + `aria-label`.

### 3.4 Görev kartı (onay bekleyen alan)
Numaralı madalyon (22px daire; aktif lacivert/beyaz, bekleyen `#EFEDE8`/ikincil) + alan adı → düz Türkçe neden açıklaması → kanıt kırpması → giriş (`1.5px solid var(--gold-600)`, mono 15px) + "Onayla" (lacivert).
Seçim gerektiren alanlarda giriş yerine tıklanabilir kısa liste (en olası 3 seçenek + "Diğer…").
Kart `flex: none; box-sizing: border-box` — kaydırılabilir kolonda ezilmeyi önler.

### 3.5 Katlanmış özet ("Doğru okunan 4 alan")
`--surface-muted` zemin, başlıkta yeşil onay ikonu ve açılır oku. İçerik: `118px` etiket kolonu + değer; satırlar `border-top: 1px solid var(--border-subtle)`.
Kişisel veri satırı maskeli: `M••••• A•••` + "kişisel veri, gizli".

### 3.6 İlişki satırı
Sol durum ikonu (yeşil onay / gri boş daire / altın uyarı) → ad + tek satır açıklama → sağda eylem ("Haritada gör", "Listeyi aç").
Kapsam ayrımı görsel olarak taşınır: **konu** (yeşil, onaylı bağ), **taraf** (nötr), **metinde geçiyor** (altın, "henüz onaylanmadı, resmî bağ kurulmadı").

### 3.7 Parsel geçmişi (soy zinciri)
Dikey zaman çizelgesi: 11px daire + `1.5px` bağlantı çizgisi (`26px` yükseklik). Renkler: geçmiş `#C4C8CE`, işlem `--amber-600`, güncel `--navy-800`.
Zorunlu açıklama: "Eski kayıt silinmez; ikisi birlikte saklanır."

### 3.8 İşlem kayıtları (denetim izi)
`96px` zaman kolonu + eylem cümlesi + aktör. Personel diliyle: "Belge okundu · otomatik, 8 saniye". Altında bütünlük şeridi (yeşil): "Asıl dosya bozulmamış — sisteme girdiği günden beri değişmedi". Karma değeri ve model sürümü yalnızca "Tümü (12)" dökümünde.

### 3.9 Alt eylem çubuğu
Üstte tek satır gerekçe metni, altında butonlar. Birincil eylem eksik alan varken devre dışı (`--disabled-fill`, `cursor: not-allowed`) ve nedeni hemen üstünde yazılı.

### 3.10 Hızlı sorgu dili
Anahtar kelimeler altın (`--gold-700`), değerler birincil metin, ikisi de mono:
`mahalle:Kandemir ada:32 parsel:2` · desteklenen alanlar: `mahalle:`, `ada:`, `parsel:`, `tur:`, `mudurluk:`, `yil:`, `ref:`

---

## 4. Ekran şartnameleri

### 4.1 Belge Doğrulama — sade düzen (`2a`, önerilen)
**Yapı:** üst bar (62) → sekme şeridi (46) → iki bölme.
- **Sol (esner):** belge görüntüleyici, tek aktif kanıt vurgusu, "Aşağıda vurgulanan yer, sağdaki soruya ait".
- **Sağ (452px):** görev başlığı → onay bekleyen alan kartları (numaralı) → katlanmış "doğru okunan" özeti → düşük öncelikli uyarı satırı (68 parsel) → alt eylem çubuğu.

**Yerleşim kuralı:** sağ kolon `overflow-y: auto`; kartlar `flex: none` + `box-sizing: border-box`.

### 4.2 Belge Doğrulama — ilişkiler ve geçmiş (`2b`)
İki kolonlu kart ızgarası (`1.15fr / 1fr`, `gap: 26`):
- Sol: "Bu belge neyle ilgili" (ilişki satırları) + "Aynı parselin diğer belgeleri" (tarih · ad · müdürlük).
- Sağ: "Parselin geçmişi" (soy zinciri) + "Belgeye ne yapıldı" (işlem kayıtları + bütünlük şeridi).

### 4.3 Yoğun düzenler (`1a`, `1b`) — yönetici/uzman kullanımı
`1a`: kalıcı koyu ikon rayı (60px) + koyu kuyruk paneli (222px) + sayfa küçük resmi kolonu (108px) + belge + alan tablosu (398px) + alt ilişki/denetim şeridi.
`1b`: tek görev odaklı; sol 430px alan akışı, sağda sekmeli belge + kanıt kırpması + soy zinciri.
Bu düzenlerde teknik gösterim (yüzde, kanıt koordinatı `[165,188,332,206]`, model sürümü, `SHA-256`, profil sürümü, ADR referansı) **açık** kalır; personel düzeninde kapalı.

**Uygulama kararı (2026-08-14):** `1a`, inceleme ekranının AÇILIP KAPANAN
yoğun kipidir — ayrı bir ekran değil. Erişim §9.3 ile aynı kapıdan geçer
(`technical.view` + tercih) ve kip açıkken teknik gösterimler kendiliğinden
açılır. `1b` AYRICA KURULMAZ: ayırt edici özellikleri (kanıt kırpması,
sekmeli belge, soy zinciri) §9 çalışmalarıyla `2a`ya taşındı; `2a` bugün
`1b`nin tarif ettiği tek görev odaklı düzenin kendisidir. İki paralel
inceleme bileşeni bakım riski üretirdi; kip yaklaşımı tek bileşen üzerinde
yaşar.

### 4.4 Mobil tarama (`3a`) — saha yakalama

**Amaç:** sahadaki memur telefon kamerasıyla tek sayfalık belgeyi güvenli
kabul hattına bırakır. **Doğrulama ve arşivleme masaüstünde kalır** — küçük
ekranda alan kanıtı karşılaştırmak yanlış onay üretir; akış bunu açıkça
söyler ("doğrulama ve arşivleme masaüstünde yapılır").

**Yapı:** tam ekran, tek görev, tek sütun (≤520px), dört adım aynı ekranda
akar: **Çek → Kontrol et → Tanımla → Yükle.**

1. **Çek:** büyük altın kesikli hedef "Belgeyi çek" (arka kamera,
   `capture=environment`); ikincil yol "Galeriden seç" (kamera izni yoksa da
   akış çalışır). Dokunma hedefleri ≥44px (§7).
2. **Kontrol et:** fotoğraf tam genişlik önizlenir; istemci kalite denetimi
   (`lib/scan-quality.ts`) düşük çözünürlüğü, karanlığı ve parlamayı ayrı
   ayrı adlandırır. Uyarı **altın karttır ve engel değildir**: tek nüsha kötü
   ışıkta da çekilmek zorunda kalabilir, OCR ön işleme kurtarmayı dener.
   Dil §6 kuralına uyar — ölçüm değil eylem cümlesi ("ışığı artırıp yeniden
   çekin"). "Yeniden çek" her an açıktır.
3. **Tanımla:** belge türü + ilgili müdürlük (kontrollü listeler); tür
   bilinmiyorsa "Tasnif bekliyor" dürüst varsayılandır.
4. **Yükle:** "Güvenli yükle" masaüstüyle ORTAK kabul zincirinden geçer
   (`upload-core.ts`: oturum → SHA-256'lı parçalar → karantina). Sonuç dili
   dürüsttür: "Belge karantinaya alındı… denetimden geçince Gelen Evrak'ta
   görünecek" — henüz belge kaydı yoktur ve akış varmış gibi davranmaz.

**Çok sayfa (bilinçli V1 sınırı):** mobil akış tek fotoğraf = tek JPEG'dir.
Akış, çok sayfalı belge için tarayıcı + PDF yolunu gösterir. İstemcide çok
fotoğraftan PDF birleştirme ayrı bir iş olarak değerlendirilebilir.

**Giriş noktası:** liste başlığındaki "Belge tara" (kamera simgesi), yalnız
dar ekranda (≤800px) görünür; geniş ekranda birincil yol yükleme diyaloğudur.

---

## 5. Durumlar

| Durum | Görünüm |
|---|---|
| Boş kuyruk | Nötr yüzeyde tek cümle + "Yeni tarama yükle" ikincil eylemi. İllüstrasyon yok. |
| Yükleniyor / OCR sürüyor | Alan iskeletleri + "Belge okunuyor" satırı; belge görüntüleyici hemen açılır (asıl dosya zaten hazır). |
| Düşük güven | Altın kart, "bilgisayar emin değil" + kanıt kırpması + düzeltilebilir giriş. |
| Zorunlu alan eksik | Kırmızı kart + kırmızı 1.5px giriş kenarı; arşivleme kilitli, neden yazılı. |
| OCR hatası | Alan listesi yerine tek blok: ne olduğu + "Yeniden işle" + elle giriş bağlantısı. Belge yine görüntülenir. |
| Karantina | Kırmızı rozet `KARANTİNA`; belge önizlemesi kapalı, yalnız üst veri ve "Neden karantinada" açıklaması. |
| Yetki reddi | Sayfa yerine tek kart: hangi yetkinin gerektiği, hangi müdürlüğün sahibi olduğu, "Erişim talebi oluştur". Belge adı/kimliği gösterilir, içerik gösterilmez. |
| Kişisel veri maskeli | `M••••• A•••` + "kişisel veri, gizli"; açma amaç kaydı ister ve işlem kayıtlarına yazılır. |
| Onaylandı | Yeşil bütünlük şeridi + "Arşivde" rozeti; alanlar salt okunur, düzeltme yeni sürüm açar. |

---

## 6. Metin dili (mikro-kopya)

- Resmî ama sade memur dili. Emoji yok, ünlem yok.
- Makine belirsizliği eylem cümlesine çevrilir: ~~"Güven: %41"~~ → "Belgede elle yazılmış. Bilgisayar bu yazıdan emin değil — belgedeki değeri kontrol edin."
- Teknik terim yerine iş terimi: `HISTORICAL_LINK` → "İfrazla ayrıldı"; `TEXT_MENTION` → "Belge metninde geçiyor — henüz onaylanmadı"; `SPATIAL` → "Yakın parsel, konumdan eşleşti".
- Kilit her zaman gerekçeli: "Belge, iki alan onaylandıktan sonra arşive alınabilir."
- Değişmezlik güvencesi görünür: "Asıl dosya hiçbir aşamada değiştirilmez."

---

## 7. Erişilebilirlik

- Hedef boyutu ≥ 36px masaüstü, ≥ 44px dokunmatik.
- Kanıt kırpması gibi dekoratif olmayan zemin görselleri `role="img"` + `aria-label` taşır.
- Durum yalnız renkle anlatılmaz: ikon + metin her zaman eşlik eder.
- Odak halkası bileşenlerde bastırılmaz; lacivert dış hat kullanılır.
- Sayı ve tarih biçimi Türkçe: `11.09.1996`, `%98,9`.

---

## 8. Uygulama notları

- **Yerleşim:** kaydırılabilir kolonlardaki kartlarda `flex: none` + `box-sizing: border-box` zorunlu; aksi hâlde son kart eziliyor.
- **Kanıt katmanı:** kutular yüzdelik konumla verilir, böylece belge genişliği değişince kayma olmaz. Kaynak koordinatlar asıl görüntü piksel uzayında saklanır, görüntüleme anında oranlanır.
- **Kanıt kırpması:** CSS `background-position` + `background-size` ile; taşan `<img>` konumlandırması kullanılmaz.
- **Yapılandırılabilir davranışlar (tasarımda anahtar olarak var):** `kanitGoster` (belge üzeri kanıt katmanı), `kisiselVeriMaskele` (KVKK maskeleme), `denetimSeridiGoster` (yoğun düzende alt denetim şeridi).
- **Örnek veri:** ekranlar gerçek bir belgeyle doğrulanmıştır — Şarkışla Belediyesi Encümen Kararı, karar no 538, 11.09.1996, Kandemir Mahallesi 32 ada 2 parsel; arşiv referansı `ARS-2026-6C472023`. OCR sonucu: karar no düşük güven (el yazısı), ilgili müdürlük bulunamadı, ek parseller kısmen şüpheli, mahalle/ada/parsel yüksek güvenle okundu ve harita kaydıyla eşleşti.

---

## 9. Açık kararlar

1. ~~Kanıt kırpmasının kaynağı~~ — **karara bağlandı (2026-08-13): anlık CSS
   kırpması.** Ayrı küçük görsel üretilmez; kırpma, personelin zaten gördüğü
   güvenli görüntüleme türevinden `background-position/size` ile anlık kesilir
   (`lib/evidence-crop.ts`). Ek depolama ve üretim hattı yoktur, WORM kasasına
   yeni nesne girmez ve kanıt türevin kendisinden sapamaz.
2. ~~"68 parsel" listesinin toplu onay ekranı~~ — **karara bağlandı
   (2026-08-13): kayan panel.** Ayrı ekran memuru belge bağlamından koparırdı;
   panel belge alanının üzerine kayar (`relation-bulk-panel.tsx`). Her satır
   kanıt kırpması ve kanıt metniyle gelir; toplu ret, seçime TEK ortak
   kontrollü gerekçeyle yazılır — farklı gerekçe gereken satır panelden
   çıkarılıp tekil akışla reddedilir.
3. ~~Yönetici düzeninde teknik gösterimin bağlanacağı yer~~ — **karara
   bağlandı (2026-08-13): yetki erişimi verir, tercih görünümü açar.**
   `technical.view` yetkisi (yönetici + arşiv sorumlusu) "Teknik görünüm"
   anahtarını erişilir kılar; açık/kapalı durumu kişisel tarayıcı tercihidir.
   Doğrulayıcı ve görüntüleyici anahtarı hiç görmez — §6 eylem dili personel
   ekranında bozulmaz. Tam `1a`/`1b` yoğun düzenleri ayrı iş olarak açık.
4. ~~Mobil tarama akışının bu dille eşleşmesi~~ — **tasarlandı ve kuruldu
   (2026-08-14): §4.4.** Tek görevlik saha yakalama akışı (Çek → Kontrol et
   → Tanımla → Yükle); kalite uyarıları eylem cümlesiyle ve engellemeden,
   yükleme masaüstüyle ortak kabul zincirinden. V1 tek sayfa; çok sayfa
   tarayıcı + PDF yoluna yönlendirilir. Doğrulama masaüstünde kalır.
5. ~~Dosya planı ve saklama kuralı seçiminin isteneceği adım~~ — **karara
   bağlandı (2026-08-14): arşivleme anında, zorunlu.** "Doğrula ve arşivle"
   bir tasnif diyaloğu açar; dosya planı ve saklama kuralı kontrollü
   sözlüklerden seçilmeden belge arşivlenemez, sunucu da kabul etmez. Kod +
   etiket karar anının anlık görüntüsü olarak belgeye ve denetim izine
   yazılır. Başlangıç listeleri TASLAKTIR ve ayarlardan yönetilir; kurumsal
   plan onayı ADR-016 gereği üretim ön koşulu olmaya devam eder.

---

## 10. Uygulama durumu

Bu şartname depoya alındı ve **renk + tipografi katmanı** uygulandı
(`app/archive/archive.css`). Uygulanan ve bekleyen kısımlar:

### Uygulandı

- §2.1 renk paleti kök tokenlar olarak tanımlandı; eski `--ar-*` adları bunların
  üzerine takma ad olarak bağlandı, böylece bütün ekranlar tek noktadan geçti.
- İlke 5 uygulandı: **kırmızı artık vurgu rengi değil**. Birincil eylem lacivert
  (`--navy-800`), marka işareti ve aktif gezinme vurgusu altın (`--gold-600`),
  kırmızı yalnız hata/karantina/eksik zorunlu alanda kaldı. Bildirim noktası
  hata değil bekleyen iş olduğu için `--amber-600`.
- Yüzeyler soğuk griden şartnamedeki sıcak griye geçti; belge görüntüleyici
  zemini `--surface-sunken`.
- Karanlık tema aynı lacivert ailesinden türetildi (şartname karanlık palet
  tanımlamıyor); durum renkleri koyu zeminde okunabilirlik için açıldı.

- §2.2 alt sınırı uygulandı: personel arayüzünde 12px altı metin kalmadı.
  Şartnamenin izin verdiği iki istisna korundu — rozet ve kanıt etiketi `11px`,
  mono referans `11.5px`. 130 bildirim rolüne göre yükseltildi; sabit
  yükseklikler §2.3'e çekildi (üst şerit 62px, araç şeridi 46px, buton 36px,
  ikincil buton 32px).

- §4.1 `2a` düzeni uygulandı: sekme şeridi (Belge ve alanlar · İlişkiler ve
  geçmiş · İşlem kayıtları), 452px görev kolonu, numaralı görev kartları ve
  katlanmış "doğru okunan" özeti. İlişkiler, nesne kayıtları ve denetim izi
  kendi sekmelerine taşındı; doğrulama kolonunda yalnız "şimdi ne yapmam
  gerekiyor" kaldı.

  **Şartnameden bilinçli sapma:** §3.5 katlanmış özeti salt okunur anlatıyor,
  burada düzenlenebilir bırakıldı. Amaç doğru okunan alanların dikkat
  çekmemesi; personelin önceden onayladığı bir değeri düzeltememesi değil.
  Arşivlendikten sonra zaten bütün alanlar salt okunur olur.

- §1 ilke 4 ve §6 uygulandı: personel arayüzünde güven yüzdesi gösterilmiyor,
  yerine eylem cümlesi geçiyor (`lib/confidence-language.ts`). Eşikler risk
  hesabıyla aynı yerlerden geçer (0.75 / 0.90) ki ekranın söylediğiyle sistemin
  hesapladığı ayrışmasın. Sayı API'de, denetim izinde ve yönetici düzenlerinde
  (§4.3) durmaya devam ediyor.

  | Yer | Önce | Sonra |
  |---|---|---|
  | Alan satırı | `Yüksek risk · %66` | `Yüksek risk · bilgisayar bu yazıdan emin değil — belgedeki değeri kontrol edin` |
  | İlişki satırı | `OCR önerisi · %83` | `OCR önerisi · bilgisayar emin değil — belgeyle karşılaştırın` |
  | Belge listesi (`Güven` → `OCR okuması`) | `%96` | `Net okundu` / `Gözden geçirin` / `Kontrol edin` |

- §4.3 teknik gösterimleri personel düzeninde kapatıldı: kanıt koordinatı, OCR
  model sürümü, nesne ve olay `SHA-256` kırpmaları, profil kodu/sürümü.
  Denetim izinde karma yerine §3.8'in istediği bütünlük ifadesi duruyor — ve
  ifade **ölçülüyor**: zincir bağları istemcide doğrulanır, kopuk zincirde şerit
  uyarıya döner. Yükleme diyalogundaki `SHA-256` terimi de iş diline çevrildi
  (§6): "Bütünlük kontrolü — aynı belge ikinci kez yüklenirse tanınır".

  Zincirin kanıtladığı şey **kaydın** değişmediğidir; asıl dosyanın bozulmadığı
  ayrı bir denetimdir (kabul anındaki SHA doğrulaması ve bütünlük mutabakatı
  işi). İfade bu yüzden dosyayı değil kaydı anlatır.

  Yönetici düzenlerinde (`1a`/`1b`) bu gösterimler açık kalacak; o düzenler
  henüz kurulmadı.

- §3.3–§3.4 kanıt katmanı tamamlandı: görev kartındaki her değer, belgede
  okunduğu yerin kırpmasını girişin üstünde gösterir (`role="img"`, 66px
  şerit); belge üzerindeki vurgu kutusu altın kenarlığa geçirildi ve bitişik
  altın ad etiketi eklendi (yalnız alan adı — yüzde yok, §3.3). Kırpma
  matematiği `lib/evidence-crop.ts` içinde saftır ve pencere-kutuyu-kesmez
  sözleşmesi testle sabitlenmiştir (`tests/evidence-crop.test.ts`). Kanıt
  kutusu olmayan değer kırpma göstermez — ilke 3 gereği kanıtı
  gösterilemeyen değer görsel bağ da kurmaz.

- §9.2 toplu parsel onayı kayan panel olarak kuruldu: İlişkiler sekmesindeki
  "Listeyi aç" girişi (≥2 öneri) belge alanının üzerine kayan paneli açar.
  Bütün öneriler seçili başlar — panelin işi şüphelileri seçimden çıkarmaktır
  ve her satır kanıtıyla (kırpma + metin) gelir, toplu onay kanıtsız onay
  değildir. Sunucu PATCH ucu istek başına 60 ilişkiyi atomik işler ve zincire
  TEK denetim olayı yazar (60 karar = 1 olay); panel fazlasını parçalara
  böler. Toplu ret seçime tek ortak gerekçeyle yazılır.

- §9.3 teknik görünüm katmanı kuruldu: `technical.view` yetkisi olan roller
  (yönetici, arşiv sorumlusu) inceleme ekranının sekme şeridinde "Teknik
  görünüm" anahtarını görür. Açıldığında ham güven yüzdesi (Türkçe biçim,
  `technicalConfidence` — biçimleme ortak çeviri modülünde, yüzeyler sayı
  çevirmez), kanıt koordinatları, model adı, profil kodu/sürümü, nesne
  SHA-256 kırpmaları ve denetim olayı karma zinciri geri gelir. Tercih
  tarayıcıda saklanır; kurumsal kayıt değildir. §4.3'ün tam `1a`/`1b`
  düzenleri henüz kurulmadı — bu katman onların işlevsel çekirdeğidir.

- §9.5 arşivleme tasnifi kuruldu: "Doğrula ve arşivle" tasnif diyaloğu açar
  (dosya planı + saklama kuralı, ikisi de zorunlu); sunucu tasnifsiz veya
  liste dışı kodla arşivlemeyi reddeder. Tasnif belge kaydına ve denetim
  olayına kod + etiket anlık görüntüsüyle yazılır; arşivlenmiş belgenin
  profil şeridinde okunur. `FILE_PLAN` ve `RETENTION_RULE` sözlükleri
  ayarlardan yönetilir; başlangıç kayıtları taslaktır (ADR-016 onay şerhi
  sözlük kaynağında durur). Diyalog, saklama süresi dolmasının otomatik imha
  olmadığını da söyler (ADR-018).

- §4.4/§9.4 mobil tarama akışı kuruldu: dar ekranda "Belge tara" girişi tam
  ekran tek görev akışını açar (kamera + galeri, kalite denetimi
  `lib/scan-quality.ts`, tür/müdürlük, ortak kabul zinciri
  `upload-core.ts`). Masaüstü yükleme diyaloğu da aynı ortak zinciri
  kullanacak biçimde sadeleştirildi; `tests/f13-upload-route` iki yüzeyin de
  ortak yolu kullandığını kaynak düzeyinde denetler.

- §4.3 yoğun düzen kuruldu: "Yoğun düzen" anahtarı (technical.view + tercih)
  inceleme ekranını 1a kipine geçirir — koyu kuyruk paneli (222px, belgeden
  belgeye listeye dönmeden geçiş), 108px küçük resim kolonu, 398px sıkışık
  alan kolonu (kırpma/ipucu gizli, satır yoğun), alt ilişki/denetim şeridi
  (ilişki çipleri + zincir durumu + son olaylar) ve 60px'e inen uygulama
  rayı. Teknik gösterimler kipte zorunlu açık. 1b ayrıca kurulmadı —
  zenginleşmiş 2a onu karşılıyor (§4.3 uygulama kararı).

- §3.10 hızlı sorgu dili kuruldu: `mahalle: ada: parsel: tur: mudurluk:
  yil: ref:` anahtarları hedefli süzgece dönüşür (`lib/quick-query.ts` +
  belgeler rotası), kalan serbest metin mevcut aramada kalır. Türkçe
  yazımlar (`tür:`, `yıl:`, `müdürlük:`) kabul edilir; çok kelimeli değer
  tırnaklıdır; bilinmeyen anahtar sessizce yutulmaz, serbest metin sayılır.
  Ada/parsel TAM eşleşir (alan değeri ya da doğrulanmış parsel ilişkisi).
  Sunucunun anladığı süzgeçler arama özetinde altın-anahtarlı mono
  çiplerle geri gösterilir; arama kutusu yer tutucusu sözdizimini öğretir.

### Bekliyor

Şartnamenin bütün açık kararları (§9.1–§9.5), ekran şartnameleri
(§4.1–§4.4) ve §3.10 sorgu dili karara bağlandı ve uygulandı. Bekleyen
tasarım işi kalmadı; sözlüklerdeki taslak kayıtların kurumsal onayı
(ADR-016) tasarım değil işletim/kurum sürecidir.
