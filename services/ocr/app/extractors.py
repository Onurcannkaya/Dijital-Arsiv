from __future__ import annotations

import re
from typing import Any

TR_UPPER = str.maketrans({"i": "İ", "ı": "I"})


def _upper(value: str) -> str:
    return value.translate(TR_UPPER).upper()


def _fold(value: str) -> str:
    """Büyük harfe çevirir ama UZUNLUĞU korur.

    Desenler sayfa metninin tamamı üzerinde çalışır ve eşleşme konumları kelime
    kutularına geri eşlenir. Bir karakterin büyük hâli iki karaktere açılırsa
    (bazı ligatürler) bu eşleme kayar ve kanıt kutusu yanlış satırı gösterir.
    """
    folded = []
    for character in value:
        mapped = character.translate(TR_UPPER).upper()
        folded.append(mapped if len(mapped) == 1 else character)
    return "".join(folded)


def _title_tr(value: str) -> str:
    lowered = value.replace("İ", "i").replace("I", "ı").lower()
    return " ".join(part[:1].translate(TR_UPPER).upper() + part[1:] for part in lowered.split())


def _box_union(words: list[dict[str, Any]]) -> list[float]:
    boxes = [word["box"] for word in words]
    return [min(box[0] for box in boxes), min(box[1] for box in boxes), max(box[2] for box in boxes), max(box[3] for box in boxes)]


def _field(
    name: str,
    value: str,
    page: dict[str, Any],
    evidence: list[dict[str, Any]],
    normalized: str | None = None,
    group: str | None = None,
) -> dict[str, Any]:
    """Tek bir alan önerisi üretir.

    Servis yalnız kanıt ve model güveni bildirir; risk seviyesi, doğrulama
    zorunluluğu ve çokluk kuralı uygulama katmanındaki belge türü profiline
    aittir (`field_definitions` tablosu).
    """
    confidence = min(float(word["confidence"]) for word in evidence)
    return {
        "name": name,
        "value": value.strip(),
        "normalizedValue": normalized.strip() if normalized else None,
        "confidence": round(confidence, 4),
        "pageNumber": int(page["pageNumber"]),
        "box": _box_union(evidence),
        "evidenceText": " ".join(word["text"] for word in evidence),
        "group": group,
    }


"""Ada/parsel jetonu ve liste ayırıcıları.

Hukuki ek korunur (`12-A`, `3/1`) ama `42-43-44` bir ek DEĞİL, üç parselin
listesidir: tevhit ve ifraz kararlarının tipik biçimi budur ve eski desen bu
ifadeyi tümüyle kaçırıyordu. Ayrım şu kuralla yapılır — `/` sonrası her şey ek
sayılır, `-` sonrası HARFLE başlıyorsa ek, RAKAMLA başlıyorsa ayırıcıdır.
"""
_TOKEN = r"\d{1,7}(?:\s*/\s*[A-ZÇĞİÖŞÜ0-9]{1,6}|\s*-\s*[A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ0-9]{0,5})?"
_PARCEL_LIST = rf"{_TOKEN}(?:\s*(?:,|-|VE)\s*{_TOKEN})*"
ADA_PARSEL = re.compile(
    rf"(?P<ada>{_TOKEN})\s*ADA\b\D{{0,20}}?(?P<parseller>{_PARCEL_LIST})\s*(?:NOLU\s*)?PARSEL"
)

"""Mahalle adı: `MAHALLESİ`den önceki TEK kelime.

Eski desen `MAHALLESİ` öncesindeki bütün büyük harf dizisini yutuyordu ve
gerçek belgede `Mustafa ŞİMŞEK'in İlimiz merkez Bahtiyarbostan Mahallesi`
ifadesinden `İn İlimiz Merkez Bahtiyarbostan` değeri üretiliyordu. Alan
kritik olmadığı için risk LOW kalıyor, yani yanlış mahalle personel
doğrulaması zorlanmadan arşive girebiliyordu.

Çok kelimeli mahalle adları ancak kontrollü sözlük yüklendiğinde doğru
çıkarılabilir; sözlük geldiğinde `neighborhoods` listesi tek kelimelik
tahminin önüne geçer (`_neighborhood`).
"""
MAHALLE = re.compile(r"(?P<ad>[A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ']{1,30})\s*,?\s*(?:MAHALLES[İI]\b|\bMH\b)")
_MAHALLE_STOP = {"MAHALLE", "ADA", "PARSEL", "NOLU", "SAYILI", "VE", "İLE", "BU", "AYNI", "İLGİLİ", "TARİHLİ"}

"""Belge tarihi: tarihsel biçimler dahil.

Eski desen yalnız sıfır dolgulu `GG.AA.YYYY` eşliyordu. Gerçek arşivde
1972/1975/1983 evrakı `24.5.1983`, `11/3/1975`, `14/3/975` yazıyor; ölçümde bu
külliyatta tarih çıkarımı %0'dı. Değer, profildeki biçim kalıbına
(`DATE_PATTERN`) uyması için sıfır dolgulu üretilir — biçim ihlali kritik
alanda riski CRITICAL'a çıkarır ve öneriyi işe yaramaz hâle getirirdi.
"""
TARIH = re.compile(r"(?<!\d)(?P<gun>\d{1,2})\s*[./-]\s*(?P<ay>\d{1,2})\s*[./-]\s*(?P<yil>\d{3,4})(?!\d)")

"""Belge sayısı (karar numarası) — VERI_SOZLUGU.md §5 `document_number`.

Encümen arşivinde memurun ilk aradığı bilgi karar numarasıdır; OCR
`SAYI: 1635` ifadesini doğru okuyor ama hiçbir desen yakalamıyordu. Eski
evrakta numara başlığın ALT satırındadır (`Sayı` / `595`), bu yüzden desen
sayfa metninin tamamı üzerinde çalışır.

`1580 sayılı kanun` gibi ifadeler eşleşmez: numara `SAYI`dan SONRA gelmek
zorundadır. Gelen evrakın `E-37347300-302.04-4315` biçimli sayısı da
eşleşmez, çünkü rakamla başlamaz.

Sondaki harf sınıfı OCR varyantları içindir: eski daktilo taramalarında `ı`
sık sık `i`, `l` veya `1` okunur (`Sayi`, `Sayl`, `Say 1`). `SAYIN` ve
`SAYILI` yine eşleşmez, çünkü aradan rakam geçmez.
"""
BELGE_SAYISI = re.compile(
    r"(?:KARAR\s*(?:NO|NUMARASI)|\bSAY\s*[IİL1])\s*[:.]?\s*(?P<no>\d{1,5})(?!\d)"
)

MUHATAP = re.compile(r"(?:İLGİLİSİ|MUHATAP)\s*[:\-]?\s*(?P<ad>[A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ\s]{2,60})")


def _units(profile: dict[str, Any]) -> list[str]:
    return [value.strip() for value in profile.get("units", []) if isinstance(value, str) and value.strip()]


def _neighborhoods(profile: dict[str, Any]) -> list[str]:
    return [value.strip() for value in profile.get("neighborhoods", []) if isinstance(value, str) and value.strip()]


def _document_types(profile: dict[str, Any]) -> list[tuple[str, list[str]]]:
    entries: list[tuple[str, list[str]]] = []
    for entry in profile.get("documentTypes", []):
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        markers = entry.get("markers")
        if isinstance(name, str) and name.strip() and isinstance(markers, list):
            cleaned = [_upper(marker) for marker in markers if isinstance(marker, str) and marker.strip()]
            if cleaned:
                entries.append((name.strip(), cleaned))
    return entries


def _page_text(page: dict[str, Any]) -> tuple[list[dict[str, Any]], str, list[int]]:
    """Sayfa metnini ve her karakterin hangi kelimeye ait olduğunu döndürür.

    Desenler satır satır değil sayfa genelinde aranır: `152 ada` ile
    `44 nolu parselden` satır sonunda ayrıldığında eski desen ikisini de
    kaçırıyordu, karar numarası ise başlığın alt satırında kalıyordu.
    """
    words = [word for word in page.get("words", []) if str(word.get("text", "")).strip()]
    pieces: list[str] = []
    owners: list[int] = []
    for index, word in enumerate(words):
        text = str(word["text"]).strip()
        if pieces:
            pieces.append(" ")
            owners.append(index)
        pieces.append(text)
        owners.extend([index] * len(text))
    return words, "".join(pieces), owners


def _evidence(words: list[dict[str, Any]], owners: list[int], start: int, end: int) -> list[dict[str, Any]]:
    """Eşleşme aralığına dokunan kelimeleri sırayla döndürür."""
    seen: list[int] = []
    for position in range(max(0, start), min(len(owners), max(end, start + 1))):
        index = owners[position]
        if index not in seen:
            seen.append(index)
    return [words[index] for index in seen] or [words[owners[start]]]


def _split_parcels(text: str) -> list[str]:
    """Parsel listesini tek tek parsellere ayırır; hukuki ek korunur."""
    parts = re.split(r"\s*,\s*|\s+VE\s+|\s*-\s*(?=\d)", text)
    return [re.sub(r"\s+", "", part) for part in parts if part.strip()]


def _normalized_date(match: re.Match[str]) -> str | None:
    """Tarihi `GG.AA.YYYY` biçimine getirir; geçersizse `None`."""
    day, month = int(match.group("gun")), int(match.group("ay"))
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return None
    raw_year = match.group("yil")
    year = int(raw_year)
    if len(raw_year) == 3:
        # Eski evrakta yüzyıl basamağı yazılmaz: `975` = 1975.
        year += 1000
    if not (1800 <= year <= 2100):
        return None
    return f"{day:02d}.{month:02d}.{year:04d}"


def _neighborhood(folded: str, match: re.Match[str], terms: list[str]) -> str | None:
    """Kontrollü sözlük varsa ondan, yoksa tek kelimelik tahminden değer üretir."""
    for term in sorted(terms, key=len, reverse=True):
        folded_term = _upper(term)
        start = match.start("ad") + len(match.group("ad")) - len(folded_term)
        if start >= 0 and folded[start:start + len(folded_term)] == folded_term:
            if start == 0 or not folded[start - 1].isalpha():
                return term
    name = match.group("ad").strip("'")
    if _upper(name) in _MAHALLE_STOP or len(name) < 3:
        return None
    return _title_tr(name)


def extract_fields(pages: list[dict[str, Any]], profile: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Belgedeki bütün alan adaylarını sırayla döndürür.

    Aynı alan adı birden çok kez dönebilir: VERI_SOZLUGU.md §8 gereği parsel,
    adres, kişi ve kurum alanlarında tek değer varsayımı yapılmaz. Tek değerli
    alanların indirgenmesi uygulama katmanında yapılır.

    Müdürlük, mahalle ve belge türü listeleri koda gömülü değildir; çağıran
    uygulama kontrollü sözlükten ve belge türü profillerinden gönderir
    (PROJE_PLANI.md 8. düzeltme maddesi). Liste gönderilmezse bu alanlar
    çıkarılmaz — servis kendi sözlüğünü uydurmaz.
    """
    profile = profile or {}
    units = _units(profile)
    neighborhoods = _neighborhoods(profile)
    document_types = _document_types(profile)

    fields: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(field: dict[str, Any]) -> None:
        key = (field["name"], field["value"])
        if field["value"] and key not in seen:
            seen.add(key)
            fields.append(field)

    for page in pages:
        words, text, owners = _page_text(page)
        if not words:
            continue
        folded = _fold(text)

        for match in ADA_PARSEL.finditer(folded):
            evidence = _evidence(words, owners, match.start(), match.end())
            ada = re.sub(r"\s+", "", match.group("ada"))
            """Grup ada değerine göre kurulur.

            Böylece `152 ada 42-43-44 nolu parseller` ifadesindeki üç parsel de
            aynı adayla eşlenir. Grup eşleşme başına kurulsaydı ada değeri
            tekrarlandığı için ikinci ve üçüncü parsel adasız kalır ve varlık
            ilişkisi hiç kurulmazdı.
            """
            group = f"parcel-{ada}"
            add(_field("ada", ada, page, evidence, ada, group))
            for parcel in _split_parcels(match.group("parseller")):
                add(_field("parcel", parcel, page, evidence, parcel, group))

        for match in MAHALLE.finditer(folded):
            value = _neighborhood(folded, match, neighborhoods)
            if value:
                evidence = _evidence(words, owners, match.start("ad"), match.end())
                add(_field("neighborhood", value, page, evidence, _upper(value)))

        for match in TARIH.finditer(text):
            value = _normalized_date(match)
            if value:
                evidence = _evidence(words, owners, match.start(), match.end())
                add(_field("document_date", value, page, evidence, value))

        for match in BELGE_SAYISI.finditer(folded):
            number = match.group("no")
            evidence = _evidence(words, owners, match.start(), match.end())
            add(_field("document_number", number, page, evidence, number))

        for match in MUHATAP.finditer(folded):
            value = " ".join(match.group("ad").split())
            evidence = _evidence(words, owners, match.start("ad"), match.end())
            add(_field("addressee", value, page, evidence, value))

        for unit in units:
            position = folded.find(_upper(unit))
            if position >= 0:
                add(_field("unit", unit, page, _evidence(words, owners, position, position + len(unit)), unit))
                break

        for name, markers in document_types:
            position = next((folded.find(marker) for marker in markers if folded.find(marker) >= 0), -1)
            if position >= 0:
                add(_field("document_type", name, page, _evidence(words, owners, position, position + 1), name))
                break

    return fields
