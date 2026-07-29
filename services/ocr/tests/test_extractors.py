import unittest

from app.extractors import extract_fields


def values(fields, name):
    return [field["value"] for field in fields if field["name"] == name]


def grouped(fields):
    pairs = {}
    for field in fields:
        if field["name"] in {"ada", "parcel"} and field["group"]:
            pairs.setdefault(field["group"], {})[field["name"]] = field["value"]
    return pairs


class ExtractorTests(unittest.TestCase):
    def test_extracts_parcel_suffix_and_evidence_box(self):
        pages = [{"pageNumber": 1, "words": [
            {"text": "Kardeşler Mahallesi 1847 ada, 12/A parsel", "confidence": 0.93, "box": [10, 20, 410, 55]},
            {"text": "İlgilisi: AHMET YILMAZ", "confidence": 0.88, "box": [10, 70, 250, 95]},
            {"text": "İmar ve Şehircilik Müdürlüğü", "confidence": 0.97, "box": [10, 110, 330, 140]},
        ]}]
        fields = extract_fields(pages)
        by_name = {field["name"]: field for field in fields}
        self.assertEqual(values(fields, "ada"), ["1847"])
        self.assertEqual(values(fields, "parcel"), ["12/A"])
        self.assertEqual(by_name["parcel"]["box"], [10, 20, 410, 55])
        self.assertEqual(by_name["unit"]["value"], "İmar ve Şehircilik Müdürlüğü")

    def test_service_does_not_decide_review_policy(self):
        """Risk ve doğrulama zorunluluğu uygulama katmanının alan politikasına aittir."""
        pages = [{"pageNumber": 1, "words": [
            {"text": "32 ada 2 parsel", "confidence": 0.41, "box": [0, 0, 100, 20]},
        ]}]
        for field in extract_fields(pages):
            self.assertNotIn("needsReview", field)
            self.assertIn("confidence", field)

    def test_keeps_every_parcel_reference_as_separate_value(self):
        """VERI_SOZLUGU.md §8: parsel alanında tek değer varsayımı yapılmaz."""
        pages = [{"pageNumber": 1, "words": [
            {"text": "Kandemir Mahallesi,32 ada,2 nolu parselin imar", "confidence": 0.98, "box": [10, 20, 410, 55]},
            {"text": "ile 32 ada 33 parsellerin imar uygulaması", "confidence": 0.97, "box": [10, 70, 410, 100]},
        ]}]
        fields = extract_fields(pages)
        self.assertEqual(values(fields, "neighborhood"), ["Kandemir"])
        # Ana parsel önce, ikinci gönderme sonra gelir; hiçbiri kaybolmaz.
        self.assertEqual(values(fields, "parcel"), ["2", "33"])
        self.assertEqual(values(fields, "ada"), ["32"])

    def test_pairs_block_and_parcel_within_a_group(self):
        pages = [{"pageNumber": 1, "words": [
            {"text": "128 ada 4 parsel", "confidence": 0.95, "box": [0, 0, 200, 20]},
            {"text": "77 ada 12-B parsel", "confidence": 0.91, "box": [0, 30, 200, 50]},
        ]}]
        pairs = grouped(extract_fields(pages))
        self.assertEqual(sorted(pairs.values(), key=lambda pair: pair["ada"]),
                         [{"ada": "128", "parcel": "4"}, {"ada": "77", "parcel": "12-B"}])


if __name__ == "__main__":
    unittest.main()
