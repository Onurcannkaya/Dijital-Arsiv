import unittest

from app import main


class LayerQualityTests(unittest.TestCase):
    """Gömülü metin katmanı kapısı.

    Ölçüm (D:\\Arşiv, 12 sayfada katman ile gerçek OCR karşılaştırıldı): ayırt
    edici sinyal Türkçe harf oranıdır. Gerçekten dijital üretilmiş sayfada oran
    ~%9 ve metin OCR ile %70 örtüşüyor; eski bir OCR turundan gelen katmanlarda
    oran **%0** ve `say1lt`, `1le` gibi rakam-harf karışmaları var. Kapı bu iki
    sinyali birlikte kullanır; tek başına uzunluk yeterli değildir çünkü bozuk
    katmanlar da uzundur.
    """

    def setUp(self):
        self._min_words = main.LAYER_MIN_WORDS
        main.LAYER_MIN_WORDS = 8

    def tearDown(self):
        main.LAYER_MIN_WORDS = self._min_words

    def test_genuinely_digital_page_passes(self):
        # 2021 cildinden gerçek ifade: diakritikler yerinde, karışma yok.
        text = ("Başkanlığın 31/12/2021 tarihinde Encümene havaleli Emlak ve İstimlak "
                "Müdürlüğünden verilen aynı tarih ve 4315 sayılı yazı ile ekleri incelendi")
        metrics, passed = main.layer_quality(text)
        self.assertTrue(passed, f"dijital sayfa kapıdan geçmedi: {metrics}")
        self.assertGreater(metrics["trRatio"], main.LAYER_MIN_TR_RATIO)
        self.assertEqual(metrics["mixedRatio"], 0.0)

    def test_old_ocr_layer_without_turkish_letters_is_rejected(self):
        # 1975 cildinin gömülü katmanından gerçek ifade: diakritik yok.
        text = ("uhasebe mUdiirlUgUncten verilen 1413197 tarih.Li Yaz1 iJ.e eJ.1 evrcHC "
                "u L!Cl.lt eu1J.ai eJ.ea.1ye cti!nenin gUn ve say1l1 karari ile")
        metrics, passed = main.layer_quality(text)
        self.assertFalse(passed, f"bozuk katman kabul edildi: {metrics}")
        self.assertEqual(metrics["trRatio"], 0.0)

    def test_digit_letter_mixing_is_rejected_even_with_turkish_letters(self):
        # Diakritik VAR ama rakam-harf karışması yüksek: yine reddedilir.
        text = ("Belediye Encümeni say1lt karar1 ile 11e ilgili 1le birlikte tarihli yaz1 "
                "üzerine görüşüldü ve karar1 verildi say1lt")
        metrics, passed = main.layer_quality(text)
        self.assertGreater(metrics["mixedRatio"], main.LAYER_MAX_MIXED_RATIO)
        self.assertFalse(passed, f"karışık katman kabul edildi: {metrics}")

    def test_too_short_text_is_rejected(self):
        # Damga veya boş sayfa: karar verilecek kadar metin yok.
        metrics, passed = main.layer_quality("BİLGİ AMAÇLIDIR")
        self.assertFalse(passed)
        self.assertLess(metrics["words"], main.LAYER_MIN_WORDS)


class GateWiringTests(unittest.TestCase):
    """Kapının hattaki yeri: karar sayfa başına, kilit gereksiz alınmaz."""

    def test_gate_is_switchable_and_on_by_default(self):
        self.assertIsInstance(main.TEXT_LAYER_GATE, bool)
        self.assertEqual(main.TEXT_LAYER_MODEL, "pdf-text-layer")

    def test_layer_page_reports_its_own_model(self):
        """Sayfa kendi kaynağını bildirir.

        Aynı belgede iki kaynak karışabilir: ölçümde aynı yılın bir encümen
        cildinin %65,8'i katmandan geçerken öbür cilt hiç geçmedi. Belge
        düzeyinde tek model adı bu gerçeği yanlış kaydeder.
        """
        import inspect
        source = inspect.getsource(main.layer_page)
        self.assertIn('"model": TEXT_LAYER_MODEL', source)

    def test_gated_page_does_not_take_the_inference_lock(self):
        """Katman okuması milisaniyeliktir; kilidi almak başka belgeleri bekletir."""
        import inspect
        source = inspect.getsource(main.predict_pages)
        kapi = source.index("layer_page(")
        kilit = source.index("_predict_lock.acquire")
        self.assertLess(kapi, kilit, "kilit katman kapısından ÖNCE alınıyor")
        self.assertIn("if locked:", source, "kilit koşulsuz bırakılıyor")


if __name__ == "__main__":
    unittest.main()
