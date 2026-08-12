import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "app"))

from planning import (
    MAX_PAGES,
    MAX_SEGMENTS,
    ReviewRequired,
    enforce_page_count,
    enforce_page_pixels,
    plan_segments,
)


class PlanningTests(unittest.TestCase):
    def test_page_count_limits(self):
        enforce_page_count(1)
        enforce_page_count(MAX_PAGES)
        with self.assertRaises(ReviewRequired):
            enforce_page_count(0)
        with self.assertRaises(ReviewRequired):
            enforce_page_count(MAX_PAGES + 1)

    def test_page_pixel_limit_uses_150_dpi(self):
        # A4 (595x842 nokta) 150 DPI'da ~1240x1754 pikseldir ve sınırın çok altındadır.
        width, height = enforce_page_pixels(595, 842)
        self.assertEqual((width, height), (1239, 1754))
        # 100 megapiksel sınırı aşan dev sayfa incelemeye düşer.
        with self.assertRaises(ReviewRequired):
            enforce_page_pixels(72_000, 72_000)

    def test_segments_are_contiguous_and_respect_size_limit(self):
        ranges = plan_segments([40, 40, 40, 40, 40], max_segment_bytes=100)
        self.assertEqual(ranges, [(1, 2), (3, 4), (5, 5)])
        self.assertEqual(plan_segments([10, 10], max_segment_bytes=100), [(1, 2)])
        with self.assertRaises(ReviewRequired):
            plan_segments([150], max_segment_bytes=100)
        with self.assertRaises(ReviewRequired):
            plan_segments([])
        with self.assertRaises(ReviewRequired):
            plan_segments([10] * (MAX_SEGMENTS + 1), max_segment_bytes=10)


if __name__ == "__main__":
    unittest.main()
