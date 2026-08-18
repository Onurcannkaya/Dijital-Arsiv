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


# Müdürlük ve belge türü sözlükleri uygulamadan gelir; servis kendi listesini tutmaz.
PROFILE = {
    "profileVersion": "1.0",
    "vocabularyVersion": "1.0",
    "units": ["İmar ve Şehircilik Müdürlüğü", "İtfaiye Müdürlüğü"],
    "documentTypes": [{"name": "Encümen karar sureti", "markers": ["ENCÜMEN KARAR"]}],
}


class ExtractorTests(unittest.TestCase):
    def test_extracts_parcel_suffix_and_evidence_box(self):
        pages = [{"pageNumber": 1, "words": [
            {"text": "Kardeşler Mahallesi 1847 ada, 12/A parsel", "confidence": 0.93, "box": [10, 20, 410, 55]},
            {"text": "İlgilisi: AHMET YILMAZ", "confidence": 0.88, "box": [10, 70, 250, 95]},
            {"text": "İmar ve Şehircilik Müdürlüğü", "confidence": 0.97, "box": [10, 110, 330, 140]},
        ]}]
        fields = extract_fields(pages, PROFILE)
        by_name = {field["name"]: field for field in fields}
        self.assertEqual(values(fields, "ada"), ["1847"])
        self.assertEqual(values(fields, "parcel"), ["12/A"])
        self.assertEqual(by_name["parcel"]["box"], [10, 20, 410, 55])
        self.assertEqual(by_name["unit"]["value"], "İmar ve Şehircilik Müdürlüğü")

    def test_without_profile_no_vocabulary_is_invented(self):
        """Sözlük gönderilmezse müdürlük ve belge türü çıkarılmaz.

        PROJE_PLANI.md 8. maddesi: sözlük koda gömülmez. Servis eksik sözlüğü
        kendi listesiyle tamamlamaz; alan boş kalır ve personel girişine düşer.
        """
        pages = [{"pageNumber": 1, "words": [
            {"text": "İmar ve Şehircilik Müdürlüğü ENCÜMEN KARARI", "confidence": 0.96, "box": [0, 0, 400, 30]},
        ]}]
        fields = extract_fields(pages)
        self.assertEqual(values(fields, "unit"), [])
        self.assertEqual(values(fields, "document_type"), [])

    def test_document_type_comes_from_supplied_markers(self):
        pages = [{"pageNumber": 1, "words": [
            {"text": "ENCÜMEN KARARI SURETİ", "confidence": 0.94, "box": [0, 0, 300, 30]},
        ]}]
        fields = extract_fields(pages, PROFILE)
        self.assertEqual(values(fields, "document_type"), ["Encümen karar sureti"])

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


def page_of(*lines):
    return [{"pageNumber": 1, "words": [
        {"text": line, "confidence": 0.95, "box": [10, 20 + index * 30, 500, 45 + index * 30]}
        for index, line in enumerate(lines)]}]


class HistoricalDateTests(unittest.TestCase):
    """Tarihsel tarih biçimleri.

    Eski desen yalnız sıfır dolgulu `GG.AA.YYYY` eşliyordu; gerçek arşivde
    1972/1975/1983 evrakı `24.5.1983`, `11/3/1975`, `14/3/975` yazıyor ve bu
    külliyatta belge tarihi çıkarımı %0'dı. Değer profildeki biçim kalıbına
    uyacak şekilde sıfır dolgulu üretilir; aksi halde biçim ihlali kritik
    alanda riski CRITICAL'a çıkarır ve öneri işe yaramaz.
    """

    def test_single_digit_month_is_normalized(self):
        fields = extract_fields(page_of("Başkanliğin 24.5.1983 tarihli encümen'e havaleli"))
        self.assertEqual(values(fields, "document_date"), ["24.05.1983"])

    def test_three_digit_year_gains_its_century(self):
        # Eski evrakta yüzyıl basamağı yazılmaz: `975` = 1975.
        fields = extract_fields(page_of("muhasebe müdürlüğünden verilen 14/3/975 tarihli yazi"))
        self.assertEqual(values(fields, "document_date"), ["14.03.1975"])

    def test_zero_padded_form_still_works(self):
        fields = extract_fields(page_of("Başkanlığın 31/12/2021 tarihinde Encümene havaleli"))
        self.assertEqual(values(fields, "document_date"), ["31.12.2021"])

    def test_numbers_that_are_not_dates_are_rejected(self):
        fields = extract_fields(page_of(
            "1580 sayılı kanunun 83.maddesi", "5.64 m2 Sivas Belediyesi", "302.04-4315",
            "32/13/2021 tarihli", "11/3/1450 tarihli",
        ))
        self.assertEqual(values(fields, "document_date"), [])


class ParcelListTests(unittest.TestCase):
    """Çoklu parsel listeleri ve satır sınırını aşan gönderiler.

    `152 ada 42-43-44 nolu parseller` tevhit/ifraz kararlarının tipik biçimidir
    ve eski desen bu ifadeyi tümüyle kaçırıyordu. Desen satır bazlı çalıştığı
    için satır sonunda bölünen ada/parsel çifti de kayboluyordu.
    """

    def test_hyphenated_list_becomes_separate_parcels(self):
        fields = extract_fields(page_of("152 ada 42-43-44 nolu parsellerin tevhidini"))
        self.assertEqual(values(fields, "ada"), ["152"])
        self.assertEqual(values(fields, "parcel"), ["42", "43", "44"])

    def test_every_parcel_shares_the_block_group(self):
        # Üç parsel de aynı adayla eşlenmeli; grup ada başına kurulur.
        groups = {field["group"] for field in extract_fields(page_of("152 ada 42-43-44 nolu parseller"))}
        self.assertEqual(groups, {"parcel-152"})

    def test_comma_and_conjunction_lists(self):
        fields = extract_fields(page_of("311 ada 28, 29 ve 30 nolu parseller"))
        self.assertEqual(values(fields, "parcel"), ["28", "29", "30"])

    def test_legal_suffix_is_not_split(self):
        fields = extract_fields(page_of("1847 ada, 12/A parsel", "77 ada 12-B parsel"))
        self.assertEqual(values(fields, "parcel"), ["12/A", "12-B"])

    def test_reference_split_across_lines_is_found(self):
        fields = extract_fields(page_of("152 ada", "44 nolu parselden 5.64 m2 Sivas Belediyesi"))
        self.assertEqual(values(fields, "ada"), ["152"])
        self.assertEqual(values(fields, "parcel"), ["44"])
        # Kanıt iki satırı birden kapsar; kutu ikisinin birleşimidir.
        parcel = next(field for field in extract_fields(page_of("152 ada", "44 nolu parselden")) if field["name"] == "parcel")
        self.assertEqual(parcel["box"], [10, 20, 500, 75])


class NeighborhoodTests(unittest.TestCase):
    """Mahalle adı `MAHALLESİ`den önceki tek kelimedir.

    Eski desen bütün büyük harf dizisini yutuyordu ve gerçek belgeden
    `İn İlimiz Merkez Bahtiyarbostan` değeri üretiliyordu. Alan kritik
    olmadığı için risk LOW kalıyor, yani yanlış mahalle personel doğrulaması
    zorlanmadan arşive girebiliyordu.
    """

    def test_long_prefix_is_not_swallowed(self):
        fields = extract_fields(page_of(
            "Mustafa ŞİMŞEK'in İlimiz merkez Bahtiyarbostan Mahallesi 152 ada 44 nolu parselden"))
        self.assertEqual(values(fields, "neighborhood"), ["Bahtiyarbostan"])

    def test_abbreviation_is_recognized(self):
        fields = extract_fields(page_of("Kizilirmak Mh. 217p1 M i pafta, 93 ada, ve 64 parseldeki"))
        self.assertEqual(values(fields, "neighborhood"), ["Kizilirmak"])

    def test_controlled_list_recovers_multi_word_names(self):
        # Sözlük yüklendiğinde çok kelimeli adlar tam çıkar; tahmin devre dışı kalır.
        profile = {**PROFILE, "neighborhoods": ["Ali Baba", "Kızılırmak"]}
        fields = extract_fields(page_of("ilimiz merkez Ali Baba Mahallesi 5 ada 1 parsel"), profile)
        self.assertEqual(values(fields, "neighborhood"), ["Ali Baba"])

    def test_stop_words_are_not_neighborhoods(self):
        fields = extract_fields(page_of("bu mahallesi ve mahallesi"))
        self.assertEqual(values(fields, "neighborhood"), [])


class DocumentNumberTests(unittest.TestCase):
    """Karar/belge sayısı — VERI_SOZLUGU.md §5 `document_number`.

    Memurun bir kararı ararken kullandığı ilk anahtar budur; OCR `SAYI: 1635`
    ifadesini doğru okuduğu hâlde hiçbir desen yakalamıyordu.
    """

    def test_modern_decision_number(self):
        fields = extract_fields(page_of("SAYI: 1635", "Başkanlığın 31/12/2021 tarihinde"))
        self.assertEqual(values(fields, "document_number"), ["1635"])

    def test_number_on_the_next_line_is_found(self):
        # Eski evrakta numara başlığın ALT satırındadır; desen sayfa genelinde arar.
        fields = extract_fields(page_of("KARAR", "Sayı :", "1695"))
        self.assertEqual(values(fields, "document_number"), ["1695"])

    def test_ocr_variants_of_the_turkish_dotless_i(self):
        # Daktilo taramalarında `ı` sık sık `i`, `l` veya `1` okunur.
        for line in ("Sayi", "Sayl", "Say 1"):
            with self.subTest(line=line):
                fields = extract_fields(page_of(line, "595"))
                self.assertEqual(values(fields, "document_number"), ["595"])

    def test_council_decision_number(self):
        fields = extract_fields(page_of("Karar No:30", "belediye meclisinin ocak AYI TOPLANTISI"))
        self.assertEqual(values(fields, "document_number"), ["30"])

    def test_incoming_letter_number_is_not_mistaken_for_it(self):
        # Gelen evrakın sayısı rakamla başlamaz; kanun atıfları da eşleşmez.
        fields = extract_fields(page_of("Sayı : E-37347300-302.04-4315", "1580 sayılı kanunun 83.maddesi"))
        self.assertEqual(values(fields, "document_number"), [])


if __name__ == "__main__":
    unittest.main()
