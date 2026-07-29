import unittest

import cv2
import numpy as np

from app.main import prepare_image


class PreprocessingTests(unittest.TestCase):
    def test_enhances_faint_scan_and_preserves_dimensions(self):
        image = np.full((240, 320), 248, dtype=np.uint8)
        cv2.putText(image, "SIVAS 32 ADA 2 PARSEL", (8, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.45, 235, 1, cv2.LINE_AA)
        ok, encoded = cv2.imencode(".jpg", image)
        self.assertTrue(ok)
        processed, enhanced, width, height, metrics = prepare_image(encoded.tobytes(), "image/jpeg")
        self.assertTrue(enhanced)
        self.assertEqual((width, height), (320, 240))
        self.assertGreater(len(processed), 0)
        self.assertLess(metrics["contrastSpan"], 80)

    def test_does_not_reprocess_bilevel_scan(self):
        image = np.full((120, 180), 255, dtype=np.uint8)
        image[40:80, 30:150] = 0
        ok, encoded = cv2.imencode(".png", image)
        self.assertTrue(ok)
        processed, enhanced, width, height, metrics = prepare_image(encoded.tobytes(), "image/png")
        self.assertFalse(enhanced)
        self.assertEqual((width, height), (180, 120))
        self.assertEqual(processed, encoded.tobytes())
        self.assertLessEqual(metrics["uniqueLevels"], 8)


if __name__ == "__main__":
    unittest.main()