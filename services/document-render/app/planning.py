"""ADR-015 erişim türevi sınır ve bölümleme kuralları.

Bu modül pdfium'a bağımlı değildir; sınır kararları saf fonksiyonlarla alınır
ve servis kurulumu olmadan test edilir.
"""
from __future__ import annotations

MAX_PAGES = 2000
MAX_PAGE_MEGAPIXELS = 100
MAX_SEGMENT_BYTES = 512 * 1024 * 1024
# Worker'ın atomik D1 sonlandırma batch'i için güvenli üst sınır.
MAX_SEGMENTS = 90
RENDER_DPI = 150
PROFILE_VERSION = "access-pdf-v1"


class ReviewRequired(Exception):
    """Güvenli türev üretilemez; iş kalıcı incelemeye alınır (ADR-015)."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"REVIEW_REQUIRED: {reason}")
        self.reason = reason


def enforce_page_count(page_count: int) -> None:
    if page_count < 1:
        raise ReviewRequired("Belgede işlenebilir sayfa yok")
    if page_count > MAX_PAGES:
        raise ReviewRequired(f"Sayfa sayısı {page_count}, sınır {MAX_PAGES}")


def enforce_page_pixels(width_points: float, height_points: float, dpi: int = RENDER_DPI) -> tuple[int, int]:
    """PDF noktası (1/72 inç) cinsinden sayfayı piksele çevirir ve sınırı uygular."""
    width_px = max(int(width_points / 72 * dpi), 1)
    height_px = max(int(height_points / 72 * dpi), 1)
    if width_px * height_px > MAX_PAGE_MEGAPIXELS * 1_000_000:
        raise ReviewRequired(
            f"Sayfa {width_px}x{height_px} piksel, sınır {MAX_PAGE_MEGAPIXELS} megapiksel"
        )
    return width_px, height_px


def plan_segments(page_byte_sizes: list[int], max_segment_bytes: int = MAX_SEGMENT_BYTES) -> list[tuple[int, int]]:
    """Sayfaları sırayla, bölüm başına bayt sınırını aşmadan aralıklara böler.

    Dönen aralıklar 1 tabanlı ve bitişiktir; tek sayfa sınırı aşıyorsa güvenli
    türev üretilemez ve iş incelemeye düşer.
    """
    if not page_byte_sizes:
        raise ReviewRequired("Bölümlenecek sayfa yok")
    segments: list[tuple[int, int]] = []
    start = 1
    used = 0
    for index, size in enumerate(page_byte_sizes, start=1):
        if size > max_segment_bytes:
            raise ReviewRequired(f"Sayfa {index} tek başına bölüm sınırını aşıyor")
        if used and used + size > max_segment_bytes:
            segments.append((start, index - 1))
            start = index
            used = 0
        used += size
    segments.append((start, len(page_byte_sizes)))
    if len(segments) > MAX_SEGMENTS:
        raise ReviewRequired(f"Bölüm sayısı {len(segments)}, sınır {MAX_SEGMENTS}")
    return segments
