import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from app.main import prepare_image


def _write_temp(encoded: np.ndarray, suffix: str) -> str:
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
        handle.write(encoded.tobytes())
        return handle.name


class PreprocessingTests(unittest.TestCase):
    """`prepare_image` dosya yolundan çalışır ve 6'lı demet döndürür.

    Önceki sürüm baytları belleğe alıyordu; F1.3 sonrası imza dosya yoluna
    geçti ve bu testler eski imzayla kırık kaldı — CI Python testlerini
    koşmadığından fark edilmedi. Testler artık gerçek imzayı kullanır.
    """

    def tearDown(self):
        for path in getattr(self, "_paths", []):
            Path(path).unlink(missing_ok=True)

    def _keep(self, *paths: str | None) -> None:
        self._paths = getattr(self, "_paths", []) + [p for p in paths if p]

    def test_enhances_faint_scan_and_preserves_dimensions(self):
        image = np.full((240, 320), 248, dtype=np.uint8)
        cv2.putText(image, "SIVAS 32 ADA 2 PARSEL", (8, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.45, 235, 1, cv2.LINE_AA)
        ok, encoded = cv2.imencode(".jpg", image)
        self.assertTrue(ok)
        source = _write_temp(encoded, ".jpg")
        processing_path, enhanced, width, height, metrics, generated_path = prepare_image(source, "image/jpeg")
        self._keep(source, generated_path)
        self.assertTrue(enhanced)
        self.assertEqual((width, height), (320, 240))
        # İyileştirme yeni bir dosya üretir; kaynak dosyanın üzerine yazılmaz.
        self.assertEqual(processing_path, generated_path)
        self.assertNotEqual(processing_path, source)
        self.assertTrue(Path(processing_path).stat().st_size > 0)
        self.assertLess(metrics["contrastSpan"], 80)

    def test_does_not_reprocess_bilevel_scan(self):
        image = np.full((120, 180), 255, dtype=np.uint8)
        image[40:80, 30:150] = 0
        ok, encoded = cv2.imencode(".png", image)
        self.assertTrue(ok)
        source = _write_temp(encoded, ".png")
        processing_path, enhanced, width, height, metrics, generated_path = prepare_image(source, "image/png")
        self._keep(source)
        self.assertFalse(enhanced)
        self.assertEqual((width, height), (180, 120))
        # Dokunulmayan görüntüde kaynak yol aynen kullanılır, türetilmiş dosya yoktur.
        self.assertEqual(processing_path, source)
        self.assertIsNone(generated_path)
        self.assertLessEqual(metrics["uniqueLevels"], 8)

    def test_non_image_passes_through(self):
        processing_path, enhanced, width, height, metrics, generated_path = prepare_image("belge.pdf", "application/pdf")
        self.assertEqual(processing_path, "belge.pdf")
        self.assertFalse(enhanced)
        self.assertIsNone(width)
        self.assertIsNone(generated_path)


if __name__ == "__main__":
    unittest.main()
