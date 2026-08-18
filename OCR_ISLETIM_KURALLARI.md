# OCR İşletim ve Dağıtım Kuralları

**Belge durumu:** Ölçüme dayalı işletim kuralları
**Tarih:** 18 Ağustos 2026
**Kapsam:** `services/ocr` dağıtımı; işçi sayısı, bellek, iş parçacığı ve motor ayarları
**Ölçüm ortamı:** Windows 10, 20 mantıksal çekirdek, 15,7 GB RAM, GPU yok, PaddleOCR 3.4 / PP-OCRv5
**Ölçüm verisi:** `D:\Arşiv` — 8 cilt, 7.029 sayfa, gerçek belediye taramaları

> Buradaki her sayı ölçülmüştür; hiçbiri tahmin değildir. Ayrıntılı ölçüm
> kayıtları `ARSIV_TARAMA_TEST_RAPORU.md` içindedir.

## 1. Kural özeti

| Kural | Değer | Gerekçe |
|---|---|---|
| İşçi başına RAM | **~5 GB** ayır | Ölçülen RSS 4.841 MB, sanal 12 GB |
| İşçi sayısı | `(RAM_GB − 6) / 5` | 15,7 GB'da 1 işçi; 2. işçi verimi yarıya düşürüyor |
| `PADDLEOCR_CPU_THREADS` | **4** | 2 → 63,9 sn; 4 → 45,7 sn; 16 → 58,8 sn |
| `OMP_NUM_THREADS` | **1** (veya hiç verme) | 4 vermek **segfault** üretiyor |
| `OPENBLAS_NUM_THREADS` | **1** | Aynı sebep |
| `OCR_PRELOAD_MODEL` | **true** | Isınma 29–150 sn; ilk gerçek belge bunu ödememeli |
| `OCR_PDF_RENDER_DPI` | **200** | 150 ve 137 dpi hız kazandırmıyor, metin kaybettiriyor |
| `OCR_TEXT_LAYER_GATE` | **true** | Arşivin %6,1'inde OCR'ı tümüyle kaldırıyor |
| Çoklu süreç yöntemi | Bağımsız işletim sistemi süreçleri | Windows'ta `multiprocessing` kilitleniyor |

## 2. Bellek işçi sayısını belirler, CPU değil

Ölçülen paralellik eğrisi (her işçi 4 iş parçacığı, 200 dpi, gerçek arşiv sayfaları):

| İşçi | sn/sayfa | Saatte sayfa | Sonuç |
|---:|---:|---:|---|
| 1 | **40,7** | **88** | en iyi |
| 2 | 155,9 | 46 | verim **yarıya** düştü |
| 3 | — | 0 | **hiçbir işçi başlayamadı** (4 sn'de çöktü) |
| 4 | 106,1 | 68 | 4 işçinin **yalnız 2'si** hayatta kaldı |

Sebep bellektir: işçi başına **4.841 MB RSS**. İki işçi 15,7 GB'lık makinenin
9,7 GB'ını alıyor, boş RAM 0,31 GB'a iniyor ve sistem takas belleğine giriyor —
ısınma 29 sn'den 140 sn'ye, sayfa süresi 40,7'den 156 sn'ye çıkıyor. 20 çekirdek
boşta durur ama kullanılamaz.

**Boyutlandırma tablosu** (6 GB işletim sistemi + uygulama payı varsayımıyla):

| Hedef işçi | Gereken RAM | 6.603 sayfa süresi |
|---:|---:|---:|
| 1 | ~11 GB | 74,7 saat |
| 2 | ~16 GB | 37,3 saat |
| 4 | ~25 GB | 18,7 saat |
| 6 | ~34 GB | 12,4 saat |

Yani hız sorunu bir yazılım ayarı sorunu değil, **bellek boyutlandırma**
sorunudur. 32 GB RAM'li bir makinede 4–6 işçi, bugünkü 74,7 saati 12–19 saate
indirir.

## 3. İş parçacığı: fazlası zarar

`PADDLEOCR_CPU_THREADS` eğrisi iki yandan kapandı:

| İş parçacığı | sn/sayfa |
|---:|---:|
| 2 | 63,9 |
| **4** | **45,7** |
| 16 | 58,8 |

Çıktı üç ayarda **birebir aynı** — yani bu bir kalite/hız dengesi değil, saf
kayıp. 20 çekirdekli makinede 4'ün üstüne çıkmak, küçük evrişimlerde eşzamanlama
maliyeti yüzünden yavaşlatıyor.

### `OMP_NUM_THREADS` 1 olmak ZORUNDA

`OMP_NUM_THREADS=4` verildiğinde servis **segfault** ile çöküyor. Paddle'ın kendi
uyarısı sebebi söylüyor:

```
WARNING: OMP_NUM_THREADS set to 4, not 1. ... It will fail if this PaddlePaddle
binary is compiled with OpenBlas since OpenBlas does not support multi-threads.
```

Bu derleme OpenBLAS ile yapılmış. Değişken **hiç verilmediğinde** ise OpenBLAS
20 çekirdeğe göre havuz açıyor ve çok işçili kurulumda bellek tükeniyor
(`OpenBLAS error: Memory allocation still failed after 10 retries`). Doğru
kurulum: her işçiye `OMP_NUM_THREADS=1` ve `OPENBLAS_NUM_THREADS=1` verip
paralelliği **süreç sayısıyla** almak.

## 4. Çoklu süreç: `multiprocessing` kullanma

Windows'ta `python` çoğu kurulumda Microsoft Store ara katmanına
(`WindowsApps\python.exe`) çözülür. `multiprocessing` spawn bu ara katmanla
birleştiğinde çocuk süreçler **hiç başlamadan** kilitlenir: ölçümde iki işçi 22
dakika boyunca 0 CPU saniyesiyle durdu. Aynı tuzak `scripts/dev-stack.mjs`
içinde de kayıtlıdır.

Doğru yöntem: her işçiyi **bağımsız bir işletim sistemi süreci** olarak, gerçek
yorumlayıcı yolundan başlatmak (`py -0p` ile bulunur). Üretimde bu zaten doğal
biçimdir — her işçi kendi konteyneri veya kendi uvicorn süreci olur.

Not: `uvicorn --workers N` tek başına yetmez. Her işçinin kendi modelini
yüklemesi (~5 GB) ve kendi tek uçuş kilidini taşıması gerekir; kilit süreç
içidir, süreçler arasında paylaşılmaz.

## 5. Uygulama tarafı: paralelliği kullanabilmek için gereken değişiklik

Makine kapasitesi artsa bile bugünkü kod onu kullanamaz:

- `lib/scheduled-jobs.ts` OCR turunu **sırayla** döndürüyor
  (`while (processed < 5)`, her adım `await`).
- Servis tek süreç olduğunda `_predict_lock` bütün çıkarımı sıraya diziyor.

Paralelliği gerçeğe çevirmek için iki değişiklik gerekir: birden çok OCR işçi
süreci **ve** uygulamanın işleri eşzamanlı dağıtması.

İkincisinin veri güvenliği **ölçüldü**. Kuyrukta altı iş varken altı eşzamanlı
tetikleme yapıldı:

| Ölçüm | Sonuç |
|---|---|
| Eşzamanlı çağrı | 6 |
| İşlenen iş | **6, hepsi ayrı belge** |
| Aynı belgeyi iki kez alan çağrı | **yok** |
| Kaybolan iş | **yok** (6 iş `completed`) |
| Duvar süresi | 52 ms |

Yani iş talep etme sorgusu (`UPDATE ... WHERE status IN ('queued','failed')
RETURNING`) eşzamanlı çağrıda doğru davranıyor: ikinci çağrının alt sorgusu
güncellenmiş durumu görüp sıradaki işi seçiyor. Dağıtımı paralelleştirmek veri
açısından güvenlidir; engel yalnız bellektir (§2).

Bu davranış `tests/ocr-concurrent-claim.test.ts` ile sabitlendi — kırılırsa
paralel dağıtım iki işçiyi aynı belgeye gönderir. Test hem davranışı hem
sorgunun tek koşullu `UPDATE` kurgusunu denetler; önce `SELECT` edip sonra
`UPDATE` eden bir kurgu aynı işi iki kez verirdi.

## 6. Motor ayarlarına DOKUNMA

Altı ayar denendi; hiçbiri kazanmadı. Değiştirilmemesi gereken ayarlar ve
gerekçeleri:

| Ayar | Denenen | Sonuç |
|---|---|---|
| `use_doc_unwarping` | kapalı | Hız yok; 1983'te iki belge tarihi, 2020'de karar numarası kaybı |
| `use_doc_orientation_classify` | kapalı | Aynı kayıplar, hız yok |
| `OCR_PDF_RENDER_DPI` | 150 / 137 | Hız yok; satır sayısı 303 → 279/284 |
| Tespit modeli | `PP-OCRv5_mobile_det` | **4,6 kat yavaş** |

Çözünürlük düşürmenin işe yaramamasının sebebi yapısaldır: tespit girdisi
`PADDLEOCR_DET_LIMIT_SIDE_LEN=1600` ile zaten küçültülüyor, tanıma kırpmaları da
sabit yüksekliğe normalleştiriliyor. Piksel azaltmak maliyeti düşürmez, yalnız
okunan metni azaltır.

## 7. Metin katmanı kapısı

Gömülü metin katmanı güvenilirse sayfa OCR'a hiç girmez
(`OCR_TEXT_LAYER_GATE=true`, öntanımlı açık).

| Ölçüt | Değişken | Öntanımlı |
|---|---|---|
| En az kelime | `OCR_LAYER_MIN_WORDS` | 40 |
| En az Türkçe harf oranı | `OCR_LAYER_MIN_TR_RATIO` | 0,03 |
| En çok rakam-harf karışma oranı | `OCR_LAYER_MAX_MIXED_RATIO` | 0,02 |

Kapının kapsaması ölçüldü — arşivde 7.029 sayfanın **426'sı** (%6,1) geçiyor:

| Cilt | Sayfa | Geçen |
|---|---:|---:|
| 2021 1-75 Encümen Asıl | 459 | 302 (%65,8) |
| 2021 1-30 Meclis | 178 | 124 (%69,7) |
| Diğer altı cilt | 6.392 | 0 |

Karar **sayfa başına** verilir, cilt başına değil: aynı yılın iki encümen
cildinden biri %65,8 geçerken öbürü hiç geçmiyor.

Kapıdan geçen sayfada `ocr_pages.model` değeri `pdf-text-layer` olur ve güven
1,0 bildirilir — değer bir model tahmini değil, belgenin kendi gömülü metnidir.
Sağlama personelde kalır: kritik alanlar profilde `VERIFY_REQUIRED` olduğu için
memur onayı olmadan belge arşive girmez.

## 8. Isınma zorunlu

`OCR_PRELOAD_MODEL=true` olmadan ilk gerçek belge oneDNN çekirdek derlemesini
öder. Ölçülen ısınma süresi tek işçide 29 sn, bellek baskısı altında 150 sn'ye
kadar çıkıyor. Isınma servis trafiğe açılmadan, `lifespan` içinde yapılır;
sağlık ucu ancak ısınmış servis için "hazır" der.

## 9. Zaman aşımı ve bütçe ilişkisi

- Uygulama tarafı tavan: `OCR_REQUEST_TIMEOUT_MS = 5 dakika`
  (`app/api/jobs/process/route.ts`).
- Servis bütçesi: `OCR_REQUEST_BUDGET_SECONDS = 240` (4 dakika).

Servis bütçesi istemci tavanından **kısa** kalmak zorundadır: bütçe dolduğunda
servis elindeki sayfayı bitirip döner ve kalan sayfayı `nextPage` ile bildirir.
Aksi hâlde istemci vazgeçer, servis çalışmaya devam eder ve tek uçuşlu kilit
saatlerce tutulur — kuyruk zehirlenir. Bu ilişki değiştirilecekse iki değer
birlikte değiştirilmelidir.
