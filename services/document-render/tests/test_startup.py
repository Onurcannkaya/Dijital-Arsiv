import ast
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "app" / "main.py"


class StartupDependencyTests(unittest.TestCase):
    """S3 istemcisi servis açılışının önkoşulu OLMAMALIDIR.

    `import boto3` modül tepesinde durduğu sürece servis, S3 yolu hiç
    kullanılmasa bile boto3 olmadan açılamıyor: yerel geliştirmede depo
    Miniflare R2 emülasyonudur ve S3 ucu yoktur, yani PDF önizlemesi yalnız bu
    import yüzünden hiç denenemiyordu. OCR servisi aynı bağımlılığı zaten
    işlev içinde alıyor; iki servis aynı düzeni izler.
    """

    def setUp(self):
        self.tree = ast.parse(SOURCE.read_text(encoding="utf-8"))

    def _top_level_modules(self):
        modules = set()
        for node in self.tree.body:
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                modules.add(node.module.split(".")[0])
        return modules

    def test_boto3_is_not_a_module_level_import(self):
        self.assertNotIn("boto3", self._top_level_modules(),
                         "boto3 modül tepesinde: servis S3 bağımlılığı olmadan açılamaz")

    def test_botocore_is_not_a_module_level_import(self):
        self.assertNotIn("botocore", self._top_level_modules(),
                         "botocore modül tepesinde: servis S3 bağımlılığı olmadan açılamaz")

    def test_s3_dependencies_are_still_declared(self):
        # Tembel import bağımlılığı gizlemek için değildir; üretim imajı onu kurar.
        requirements = (SOURCE.parents[1] / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("boto3", requirements)


if __name__ == "__main__":
    unittest.main()
