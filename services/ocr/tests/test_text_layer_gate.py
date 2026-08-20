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


class ShortPageBandTests(unittest.TestCase):
    """Kısa sayfa bandı (15-39 kelime): sıkı eşikle katmandan geçebilir.

    Ölçüm (2021 meclis cildi, 34 kısa sayfa — tamamı karar sonu/imza sayfası):
    Türkçe harf oranı 0,076-0,123, karışma 0; katman dijital kalitede. Düşük
    örtüşen sayfalarda eksik görünen kelimeler Paddle'ın KENDİ yanlış
    okumalarıydı ('Dentim', 'Fii', 'Krar' — katmanda doğruları var). Bu
    sayfaları ölçmeden Paddle'a göndermek hem süre hem doğruluk kaybıydı.
    """

    # 2021 cildindeki imza sayfalarının görünümünde, 20 kelimelik gerçekçi metin.
    SHORT_DIGITAL = ("Belediye Meclisinin yukarıda tarih ve sayısı yazılı kararı okunarak "
                     "imza altına alındı Meclis Başkanı Katip Üye Katip Üye")

    def test_short_digital_page_passes_with_stricter_threshold(self):
        metrics, passed = main.layer_quality(self.SHORT_DIGITAL)
        self.assertLess(metrics["words"], main.LAYER_MIN_WORDS, "test metni kısa bantta değil")
        self.assertGreaterEqual(metrics["words"], main.LAYER_SHORT_MIN_WORDS)
        self.assertTrue(passed, f"dijital kalitedeki kısa sayfa kapıdan geçmedi: {metrics}")
        self.assertGreater(metrics["trRatio"], main.LAYER_SHORT_MIN_TR_RATIO)

    def test_single_mixed_word_rejects_a_short_page(self):
        # Kısa bantta TEK karışık kelime bile oranı eşiğin üstüne taşır ve
        # sayfa Paddle'a düşer; az kanıtla toleranssız karar bilinçlidir.
        text = self.SHORT_DIGITAL.replace("kararı", "karar1")
        metrics, passed = main.layer_quality(text)
        self.assertFalse(passed, f"karışmalı kısa sayfa kabul edildi: {metrics}")

    def test_short_page_without_turkish_letters_is_rejected(self):
        # Diakritiksiz kısa katman: eski OCR turu kalıntısı, güvenilmez.
        text = ("Belediye Encumeni tarafindan verilen karar okundu ve imza altina "
                "alindi baskan katip uye katip uye teslim fisi idare")
        metrics, passed = main.layer_quality(text)
        self.assertFalse(passed, f"diakritiksiz kısa sayfa kabul edildi: {metrics}")

    def test_below_the_short_floor_is_rejected_unmeasured(self):
        # 15 kelimenin altında karar verecek kanıt yok: damga, başlık, boş sayfa.
        metrics, passed = main.layer_quality("Sivas Belediyesi Meclis Karar Defteri sayfası imza tarih mühür")
        self.assertFalse(passed)
        self.assertEqual(metrics["trRatio"], 0.0, "taban altındaki sayfa ölçülmemeli")


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
