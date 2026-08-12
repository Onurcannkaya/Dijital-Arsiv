import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "app"))

from file_validation import classify_clamav_exit, detect_media_type, type_validation, validate_parser

try:
    from PIL import Image
except ImportError:
    Image = None


class FileValidationTests(unittest.TestCase):
    def test_magic_bytes(self):
        self.assertEqual(detect_media_type(b"%PDF-1.7\n"), "application/pdf")
        self.assertEqual(detect_media_type(b"\xff\xd8\xff\xe0"), "image/jpeg")
        self.assertEqual(detect_media_type(b"\x89PNG\r\n\x1a\n"), "image/png")
        self.assertEqual(detect_media_type(b"II*\x00"), "image/tiff")
        self.assertIsNone(detect_media_type(b"MZ\x90\x00"))
        self.assertIsNone(detect_media_type(b"MZ\x90\x00%PDF-1.7"))

    def test_declared_type_and_extension_must_both_match(self):
        self.assertEqual(type_validation("application/pdf", ".pdf", "application/pdf"), "MATCH")
        self.assertEqual(type_validation("application/pdf", ".exe", "application/pdf"), "MISMATCH")
        self.assertEqual(type_validation("application/pdf", ".pdf", None), "UNSUPPORTED")

    def test_clamav_exit_contract_includes_eicar_result(self):
        self.assertEqual(classify_clamav_exit(0), "CLEAN")
        self.assertEqual(classify_clamav_exit(1), "MALICIOUS")
        self.assertEqual(classify_clamav_exit(2), "ERROR")

    # Regresyon: görsel doğrulama yolu gerçekten çalıştırılmalıdır. Eksik
    # `import warnings` her görsel taramasını NameError ile düşürüyordu ve
    # yalnız magic-byte testleri koştuğu için görünmüyordu.
    @unittest.skipUnless(Image, "Pillow kurulu değil")
    def test_image_parser_validates_real_png(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.png"
            Image.new("RGB", (4, 4), "white").save(path, "PNG")
            name, version, result = validate_parser(path, "image/png")
            self.assertEqual((name, result), ("pillow", "VALID"))
            self.assertTrue(version)

    @unittest.skipUnless(Image, "Pillow kurulu değil")
    def test_image_parser_rejects_wrong_format_and_truncated_content(self):
        with tempfile.TemporaryDirectory() as directory:
            disguised = Path(directory) / "disguised.png"
            Image.new("RGB", (4, 4), "white").save(disguised, "JPEG")
            self.assertEqual(validate_parser(disguised, "image/png")[2], "INVALID")

            truncated = Path(directory) / "truncated.png"
            intact = Path(directory) / "intact.png"
            Image.new("RGB", (64, 64), "white").save(intact, "PNG")
            truncated.write_bytes(intact.read_bytes()[:40])
            self.assertEqual(validate_parser(truncated, "image/png")[2], "INVALID")


if __name__ == "__main__":
    unittest.main()
