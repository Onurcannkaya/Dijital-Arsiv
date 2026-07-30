import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "app"))

from file_validation import classify_clamav_exit, detect_media_type, type_validation


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


if __name__ == "__main__":
    unittest.main()
