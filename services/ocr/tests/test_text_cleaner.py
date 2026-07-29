import unittest

from app.text_cleaner import readable_text, search_text


def line(text, top, bottom, left=100):
    return {"text": text, "confidence": 0.95, "box": [left, top, 800, bottom]}


class TextCleanerTests(unittest.TestCase):
    def test_joins_hyphenated_lines_and_builds_paragraphs(self):
        words = [
            line("ENCÜMEN KARARI", 10, 35),
            line("Belediye Encümeni aşağıda yazılı üyele-", 75, 100),
            line("rin iştirakleriyle toplandı.", 104, 129),
            line("KARAR", 180, 205),
            line("Kandemir Mahallesi, 32 ada, 2 nolu parselin", 240, 265),
            line("imar uygulaması uygun görülmüştür.", 269, 294),
        ]

        result = readable_text(words)

        self.assertIn("üyelerin iştirakleriyle", result)
        self.assertIn("ENCÜMEN KARARI\n\n", result)
        self.assertIn("\n\nKARAR\n\n", result)
        self.assertIn("parselin imar uygulaması", result)
        self.assertNotIn("11. 09. 1996", readable_text([line("11.09.1996", 10, 35)]))

    def test_search_form_is_diacritic_and_common_ocr_error_tolerant(self):
        result = search_text("Tapu Sici1 Müdürlüğü, 1580 sayılı yasa")

        self.assertIn("tapu sicil mudurlugu", result)
        self.assertIn("1580 sayili yasa", result)


if __name__ == "__main__":
    unittest.main()
class SafeCorrectionTests(unittest.TestCase):
    def test_applies_only_known_mechanical_ocr_corrections(self):
        result = readable_text([line("TARIHL1 Tapu Sici1 Müdürlüğü 1580 say11i yasa", 10, 35)])
        self.assertIn("TARİHLİ Tapu Sicil Müdürlüğü 1580 sayılı yasa", result)