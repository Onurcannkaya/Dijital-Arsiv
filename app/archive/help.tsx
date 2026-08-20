"use client";

import {
  Archive, Camera, CircleHelp, FileCheck2, FileSearch, LifeBuoy, RotateCcw,
  ScanLine, Search, ShieldCheck, Upload,
} from "lucide-react";

/**
 * Yardım ve destek — memur el kitabının ekran hâli.
 *
 * İçerik uygulamanın GERÇEK davranışından derlenmiştir; burada anlatılan her
 * düğme ve durum etiketi kodda vardır. Yeni bir akış eklendiğinde bu ekran da
 * güncellenmelidir — yardım metni gerçeklikten koparsa memuru yanıltır ve
 * hiç olmamasından daha kötüdür (tests/yardim-icerigi kaynak denetimi temel
 * başlıkları kilitler).
 *
 * Bilinçli sınır: ekran görüntüsü ve video yoktur; içerik metin + durum
 * tablolarıdır ki PWA önbelleğinde hafif kalsın ve arayüz değişince bayat
 * görüntü kalıntısı bırakmasın.
 */

const sessionStates: Array<[string, string]> = [
  ["Tarama bekliyor / Taranıyor", "Dosya karantinada; tür ve zararlı içerik taraması sırada ya da sürüyor."],
  ["Tarama temiz; kasa aktarımı sırada / Kasaya aktarılıyor", "Tarama geçti; dosya değişmez asıl kasasına yazılıyor."],
  ["Mükerrer — bu belge zaten arşivde", "Aynı içerik daha önce kabul edilmiş. Satırdaki düğme sizi mevcut belgeye götürür; yeniden yüklemeye gerek yoktur."],
  ["Süresi doldu; yeniden yükleyin", "Yükleme oturumu 24 saat içinde tamamlanmadı. Dosyayı yeniden yükleyin."],
  ["Reddedildi", "Dosya türü bildirilenle uyuşmadı ya da zararlı içerik bulundu. Satırdaki koda bakın; gerekiyorsa Bilgi İşlem'e başvurun."],
  ["Başarısız", "Kasa aktarımı arızalandı. Yetkili operatör 'Kurtarma bekleyen yüklemeler' panelinden gerekçeyle terfiye geri alabilir; dosyanız kaybolmaz."],
];

const documentStates: Array<[string, string]> = [
  ["OCR kuyruğunda", "Belge kabul edildi, okunmayı bekliyor."],
  ["İşleniyor", "Belge okunuyor; uzun ciltlerde bu durum sayfa sayısına göre sürer."],
  ["Doğrulama", "Okuma bitti; alanlarda kararınızı bekleyen değer var."],
  ["Doğrulamaya hazır", "Bütün alan kararları verildi; belge onaya sunulmuş durumda."],
  ["Arşivlendi", "Belge tasnifiyle birlikte kalıcı arşivde. Arşivlenmiş kayıt değiştirilemez."],
  ["OCR hatası", "Okuma azami denemeyi tüketti. Belgeyi açıp 'Belgeyi okut' ile yeniden deneyin ya da yetkiliye bildirin."],
];

function Section({ icon: Icon, title, children }: { icon: typeof Upload; title: string; children: React.ReactNode }) {
  return <section className="panel help-section">
    <header><div><span className="modal-icon"><Icon size={18} /></span><h2>{title}</h2></div></header>
    <div className="help-body">{children}</div>
  </section>;
}

export function HelpScreen() {
  return <>
    <section className="heading"><div><p className="eyebrow">YARDIM VE DESTEK</p>
      <h1>Arşiv çalışma alanı el kitabı</h1>
      <span>Belgenin yüklemeden arşive yolculuğu, ekran ekran. Burada anlatılan her düğme uygulamada vardır.</span></div></section>

    <Section icon={Upload} title="Belge yükleme — hızlı kabul sihirbazı">
      <p>&quot;Belge ekle&quot; düğmesi dört adımlı sihirbazı açar: <b>Belgeler → Yükleme ve okuma → Kontrol → Özet</b>. İleri diyerek ilerlersiniz.</p>
      <ul>
        <li><b>Birden çok dosya seçebilirsiniz</b> (seçici ya da sürükle-bırak). Dosyalar sırayla yüklenir; birinin hatası diğerlerini durdurmaz.</li>
        <li>Kabul edilen biçimler: <b>PDF, JPG, PNG, TIFF</b>; dosya başına en fazla <b>2 GiB</b>. Belge türü ve müdürlük seçimi adımda seçtiğiniz bütün dosyalara uygulanır.</li>
        <li>Her dosya güvenlik taramasından geçer, değişmez kasaya alınır ve okunur (OCR). İlerlemeyi dosya satırında izlersiniz.</li>
        <li><b>Kontrol adımı</b>: okumanın yakaladığı alanları (müdürlük, tarih, ada/parsel...) düzeltip &quot;Kaydet ve onaya sun&quot; dersiniz. Beklemek istemezseniz <b>&quot;Arka planda sürsün&quot;</b> — okuma sunucuda devam eder, belge hazır olunca Doğrulama listesine düşer.</li>
        <li>Aynı dosyayı ikinci kez yüklerseniz sistem tanır ve mevcut belgeye yönlendirir; arşivde kopya oluşmaz.</li>
      </ul>
    </Section>

    <Section icon={Camera} title="Mobil tarama">
      <p>Dar ekranda &quot;Belge tara&quot; kamerayı açar. Mobil akış <b>tek sayfa</b> içindir: bir fotoğraf, bir belge olur. Çok sayfalı evrakı sayfaları tarayıcıdan geçirip <b>tek PDF olarak masaüstünden</b> yükleyin. Bulanık, karanlık ya da parlamalı fotoğrafta uygulama yeniden çekmenizi ister.</p>
    </Section>

    <Section icon={ScanLine} title="Belgenin yolculuğu ve durum etiketleri">
      <p>Yüklediğiniz dosya önce <b>Bekleyen yüklemeler</b> şeridinde görünür (Gelen Evrak). Dosyanız kaybolmaz; hangi aşamada beklediğini ve sonuçlanan denemelerin nedenini bu şerit söyler:</p>
      <table><tbody>{sessionStates.map(([state, meaning]) =>
        <tr key={state}><td><b>{state}</b></td><td>{meaning}</td></tr>)}</tbody></table>
      <p>Kasaya alınan dosya belge olur ve listelerde şu durumlarla ilerler:</p>
      <table><tbody>{documentStates.map(([state, meaning]) =>
        <tr key={state}><td><b>{state}</b></td><td>{meaning}</td></tr>)}</tbody></table>
    </Section>

    <Section icon={FileCheck2} title="Doğrulama ve onaya sunma">
      <ul>
        <li>Belgeyi açınca sol tarafta sayfalar, ortada belge görüntüsü ya da okunan metin, sağda <b>alan kararları</b> bulunur. Her önerilen değeri <b>onaylar, düzeltir ya da reddedersiniz</b>.</li>
        <li><b>Ret gerekçesizi olmaz</b>: gerekçe kontrollü listeden seçilir ve denetim izine yazılır. Boş alan onaylanamaz; tek değerli alan (tarih, tür, müdürlük) reddedilmez, doğrusu yazılarak <b>düzeltilir</b>.</li>
        <li>Biçim kuralına uymayan değer düzeltme sırasında yalnız <b>uyarır</b> (belgede ne yazıyorsa onu girebilmelisiniz); <b>arşivlemede ise engeldir</b>, çünkü arşivlenmiş kayıt değiştirilemez.</li>
        <li><b>Tam metin</b> de personel onayı ister: metni okuyup gerekiyorsa düzeltin ve onaylayın; onaysız metinli belge arşivlenemez.</li>
        <li>Ada/parsel önerileri <b>varlık ilişkisi</b> olarak ayrıca kontrol edilir; çok önerili belgede toplu karar paneli vardır.</li>
        <li><b>Arşivleme</b> tasnif ister: dosya planı ve saklama kuralı seçilmeden belge arşive giremez. Arşivlenen belge ve dosyası bir daha değiştirilemez.</li>
      </ul>
    </Section>

    <Section icon={Search} title="Arama">
      <p>Üstteki kutu (kısayol: <b>Ctrl K</b>, temizlemek için <b>Esc</b>) onaylı metinde, alan değerlerinde ve doğrulanmış ilişkilerde arar; en az iki karakter yazın. Hedefli süzgeçler:</p>
      <p className="help-mono">ada:32 &nbsp; parsel:2 &nbsp; mahalle:Kandemir &nbsp; tur:Encümen &nbsp; yil:1996 &nbsp; ref:ARS-2026</p>
      <p>Anlaşılan süzgeçler sonucun üstünde gösterilir; yazdığınız süzgecin çalıştığını oradan doğrularsınız.</p>
    </Section>

    <Section icon={RotateCcw} title="Sorun giderme">
      <ul>
        <li><b>Dosyam listede görünmüyor:</b> Gelen Evrak&apos;taki Bekleyen yüklemeler şeridine bakın; tarama/kasa aşamasındaki dosya henüz belge listesine düşmez.</li>
        <li><b>&quot;Mükerrer&quot; dedi:</b> aynı içerik zaten arşivde. Satırdaki &quot;Mevcut belgeyi aç&quot; ile kayda gidin.</li>
        <li><b>Okuma başarısız (OCR hatası):</b> belgeyi açıp <b>&quot;Belgeyi okut&quot;</b> ile yeniden deneyin. Azami denemeyi tüketen işler yetkililerin gördüğü <b>Okuma arızaları</b> panelinden kuyruğa geri alınır.</li>
        <li><b>Kasa aktarımı başarısız:</b> yetkili operatör <b>Kurtarma bekleyen yüklemeler</b> panelinden gerekçe yazarak terfiye geri alır; pencere arızadan sonra 7 gündür, kapanırsa dosya yeniden yüklenir.</li>
        <li><b>Hata mesajı aldım:</b> mesajdaki <b>olay kimliğini</b> (&quot;Destek için olay kimliği: ...&quot;) not edin; Bilgi İşlem bu kimlikle kaydı bulur.</li>
      </ul>
    </Section>

    <Section icon={ShieldCheck} title="Yetkiler kısaca">
      <ul>
        <li><b>Görüntüleyici</b> belge listesini ve içeriğini görür; <b>doğrulayıcı</b> alan/metin/ilişki kararı verir.</li>
        <li><b>Arşiv sorumlusu</b> ek olarak yükler, indirir, arşivler, okumayı yeniden başlatır ve kurtarma/arıza panellerini kullanır.</li>
        <li><b>Yönetici</b> bunlara ek olarak kullanıcıları, müdürlük listesini, sözlükleri ve işletim ölçümlerini yönetir (Ayarlar).</li>
        <li>Belge görmek ile <b>indirmek ayrı yetkilerdir</b>; her görüntüleme ve indirme denetim izine yazılır.</li>
      </ul>
    </Section>

    <Section icon={LifeBuoy} title="Destek">
      <p>Çözülmeyen sorun için <b>Bilgi İşlem Müdürlüğü</b>ne başvurun. Bildirirken şunları ekleyin: ne yapmaya çalıştığınız, belgenin referans numarası (örn. <span className="help-mono">ARS-2026-1A2B3C4D</span>) ve varsa hata mesajındaki olay kimliği. Sistem sağlığını yöneticiler Ayarlar ekranından izler.</p>
    </Section>

    <p className="help-footnote"><CircleHelp size={14} /> Bu el kitabı uygulamayla birlikte güncellenir; ekranda görmediğiniz bir düğme anlatılıyorsa yetkiniz kapsamında olmayabilir.</p>
    <p className="help-footnote"><FileSearch size={14} /> Arşivlenmiş belgeyi bulmak için Dijital Arşiv sekmesini, karar bekleyenler için Doğrulama sekmesini kullanın.</p>
    <p className="help-footnote"><Archive size={14} /> Asıl dosya hiçbir işlemde değişmez; okuma ve görüntüleme kopyaları ayrı üretilir.</p>
  </>;
}
