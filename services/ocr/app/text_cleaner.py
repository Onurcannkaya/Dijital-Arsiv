from __future__ import annotations

import re
import unicodedata
from statistics import median
from typing import Any

_HEADING_MAX_LENGTH = 72
_TERMINAL_PUNCTUATION = (".", ":", ";", "?", "!")
_SUFFIX_FRAGMENTS = {
    "lar", "ler", "rin", "nin", "nın", "nun", "nün", "dan", "den", "dır", "dir", "dur", "dür",
    "miz", "mız", "muz", "müz", "mize", "mıza", "niz", "nız", "nuz", "nüz", "nize", "nıza",
}
_SAFE_CORRECTIONS = {
    "sici1": "sicil",
    "sayi11": "sayılı",
    "sayi1i": "sayılı",
    "tarihl1": "tarihli",
    "11e": "ile",
    "encomen": "encümen",
    "encimenimize": "encümenimize",
    "say11i": "sayılı",
    "say1li": "sayılı",
    "sayili": "sayılı",
    "sarkisla": "şarkışla",
    "baskani": "başkanı",
    "baskanliginda": "başkanlığında",
    "asagida": "aşağıda",
    "yazili": "yazılı",
    "öyelerin": "üyelerin",
    "istirakleriyle": "iştirakleriyle",
    "toplandi": "toplandı",
    "dilekce": "dilekçe",
    "degerlendirilmesiyle": "değerlendirilmesiyle",
    "uygulamasi": "uygulaması",
    "yapilmasi": "yapılması",
    "yasanin": "yasanın",
    "geregi": "gereği",
    "oldugu": "olduğu",
    "ayni": "aynı",
    "ayrica": "ayrıca",
    "bolgede": "bölgede",
    "basvurusuna": "başvurusuna",
    "karariyla": "kararıyla",
    "yaziyla": "yazıyla",
    "kutuklerine": "kütüklerine",
    "serh": "şerh",
    "kayitlari": "kayıtları",
    "icin": "için",
    "simdi": "şimdi",
    "goruldugu": "görüldüğü",
}


def _match_case(original: str, corrected: str) -> str:
    if original.isupper():
        return corrected.replace("i", "İ").replace("ı", "I").upper()
    if original[:1].isupper():
        return corrected[:1].upper() + corrected[1:]
    return corrected


def _correct_common_errors(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        original = match.group(0)
        corrected = _SAFE_CORRECTIONS.get(original.casefold())
        return _match_case(original, corrected) if corrected else original

    return re.sub(r"\b[\wÇĞİÖŞÜçğıöşü]+\b", replace, value, flags=re.UNICODE)


def _normalize_fragment(value: str) -> str:
    text = unicodedata.normalize("NFC", value)
    text = text.replace("\u00ad", "").replace("–", "-").replace("—", "-")
    text = re.sub(r"[ \t]+", " ", text).strip()
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"([,;:!?])(?=\S)", r"\1 ", text)
    text = re.sub(r"(?<=[a-zçğıöşü])\.(?=[A-ZÇĞİÖŞÜ])", ". ", text)
    return _correct_common_errors(text)


def _looks_like_heading(text: str) -> bool:
    letters = [character for character in text if character.isalpha()]
    return bool(letters) and len(text) <= _HEADING_MAX_LENGTH and sum(character.isupper() for character in letters) / len(letters) >= 0.82


def _line_height(word: dict[str, Any]) -> float:
    box = word.get("box", [0, 0, 0, 0])
    return max(float(box[3]) - float(box[1]), 1.0)


def _vertical_gap(previous: dict[str, Any], current: dict[str, Any]) -> float:
    return float(current["box"][1]) - float(previous["box"][3])


def _starts_with_suffix_fragment(text: str) -> bool:
    first = re.match(r"([a-zçğıöşü]+)\b", text)
    return bool(first and first.group(1) in _SUFFIX_FRAGMENTS)


def readable_text(words: list[dict[str, Any]]) -> str:
    """Turn OCR line fragments into readable paragraphs without discarding raw evidence."""
    lines = [{**word, "text": _normalize_fragment(str(word.get("text", "")))} for word in words if str(word.get("text", "")).strip()]
    lines = [line for line in lines if not re.fullmatch(r"[:;,.]", line["text"])]
    if not lines:
        return ""

    typical_height = median(_line_height(line) for line in lines)
    paragraphs: list[str] = []
    current = ""
    previous: dict[str, Any] | None = None

    for line in lines:
        text = line["text"]
        heading = _looks_like_heading(text)
        gap = _vertical_gap(previous, line) if previous else 0
        paragraph_break = bool(previous and (gap > typical_height * 0.72 or heading or _looks_like_heading(previous["text"])))

        if paragraph_break and current:
            paragraphs.append(current.strip())
            current = ""

        if not current:
            current = text
        elif current.endswith("-") and text[:1].islower():
            current = current[:-1] + text
        elif not current.endswith(_TERMINAL_PUNCTUATION) and _starts_with_suffix_fragment(text):
            current += text
        else:
            current += " " + text
        previous = line

    if current:
        paragraphs.append(current.strip())

    cleaned = "\n\n".join(paragraphs)
    cleaned = re.sub(r"(?<=\w)-\s+(?=[a-zçğıöşü])", "", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned.strip()


# NOT: Aranabilir metin biçimi bilinçli olarak burada üretilmez.
# Aynı kural iki dilde iki kez yazıldığında dizin ile sorgu farklı biçimler
# üretiyor ve eşleşmeler sessizce kayboluyordu. Tek uygulama
# `lib/text-search.ts` içindeki `normalizeSearch` fonksiyonudur.