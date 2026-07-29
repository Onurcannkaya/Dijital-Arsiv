from __future__ import annotations

import re
from typing import Any

TR_UPPER = str.maketrans({"i": "İ", "ı": "I"})


def _upper(value: str) -> str:
    return value.translate(TR_UPPER).upper()


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


# `32 ada, 2 nolu parsel` gibi ifadelerden ada ve parsel değerini birlikte alır.
# Hukuki ekler (`12-A`, `3/1`) korunur.
ADA_PARSEL = re.compile(
    r"(?P<ada>\d{1,7})\s*ADA\D{0,20}(?P<parsel>\d{1,7}(?:\s*[/-]\s*[A-Z0-9]+)?)\s*(?:NOLU\s*)?PARSEL"
)
MAHALLE = re.compile(r"([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ\s]{1,45})\s+MAHALLES[İI]")
TARIH = re.compile(r"\b(\d{2}[./-]\d{2}[./-]\d{4})\b")
MUHATAP = re.compile(r"(?:İLGİLİSİ|MUHATAP)\s*[:\-]?\s*([A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ\s]{2,60})")


def _units(profile: dict[str, Any]) -> list[str]:
    return [value.strip() for value in profile.get("units", []) if isinstance(value, str) and value.strip()]


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


def extract_fields(pages: list[dict[str, Any]], profile: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Belgedeki bütün alan adaylarını sırayla döndürür.

    Aynı alan adı birden çok kez dönebilir: VERI_SOZLUGU.md §8 gereği parsel,
    adres, kişi ve kurum alanlarında tek değer varsayımı yapılmaz. Tek değerli
    alanların indirgenmesi uygulama katmanında yapılır.

    Müdürlük ve belge türü listeleri koda gömülü değildir; çağıran uygulama
    kontrollü sözlükten ve belge türü profillerinden gönderir
    (PROJE_PLANI.md 8. düzeltme maddesi). Liste gönderilmezse bu alanlar
    çıkarılmaz — servis kendi sözlüğünü uydurmaz.
    """
    profile = profile or {}
    units = _units(profile)
    document_types = _document_types(profile)

    fields: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    parcel_group = 0

    def add(field: dict[str, Any]) -> None:
        key = (field["name"], field["value"])
        if field["value"] and key not in seen:
            seen.add(key)
            fields.append(field)

    for page in pages:
        for word in page.get("words", []):
            text = str(word.get("text", "")).strip()
            if not text:
                continue
            upper = _upper(text)

            for match in ADA_PARSEL.finditer(upper):
                ada = match.group("ada")
                parsel = re.sub(r"\s+", "", match.group("parsel"))
                # Ada ve parsel aynı grubu taşır; varlık ilişkisi bu eşleşmeden kurulur.
                parcel_group += 1
                group = f"parcel-{parcel_group}"
                before = len(fields)
                add(_field("ada", ada, page, [word], ada, group))
                add(_field("parcel", parsel, page, [word], parsel, group))
                if len(fields) == before:
                    parcel_group -= 1

            for match in MAHALLE.finditer(upper):
                value = _title_tr(match.group(1))
                add(_field("neighborhood", value, page, [word], _upper(value)))

            for match in TARIH.finditer(text):
                value = match.group(1).replace("/", ".").replace("-", ".")
                add(_field("document_date", value, page, [word], value))

            for match in MUHATAP.finditer(upper):
                value = " ".join(match.group(1).split())
                add(_field("addressee", value, page, [word], value))

            for unit in units:
                if _upper(unit) in upper:
                    add(_field("unit", unit, page, [word], unit))
                    break

            for name, markers in document_types:
                if any(marker in upper for marker in markers):
                    add(_field("document_type", name, page, [word], name))
                    break

    return fields
