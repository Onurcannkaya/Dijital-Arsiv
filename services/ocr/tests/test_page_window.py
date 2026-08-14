import threading
import time
import unittest

from fastapi import HTTPException

from app import main


class FakeBitmap:
    def __init__(self, array):
        self._array = array

    def to_numpy(self):
        return self._array


class FakePage:
    def __init__(self, array):
        self._array = array

    def render(self, scale):  # noqa: ARG002 - ölçek testte önemsizdir
        return FakeBitmap(self._array)


class FakeDocument:
    """pdfium belgesinin testte yeterli olan yüzü."""

    def __init__(self, page_count):
        import numpy as np
        self._pages = [np.zeros((8, 6, 3), dtype="uint8") for _ in range(page_count)]

    def __len__(self):
        return len(self._pages)

    def __getitem__(self, index):
        return FakePage(self._pages[index])


class FakeEngine:
    """Her çağrıda tek sayfalık sonuç döndürür; süresi ayarlanabilir."""

    def __init__(self, seconds=0.0):
        self.seconds = seconds
        self.calls = 0

    def predict(self, _image):
        self.calls += 1
        if self.seconds:
            time.sleep(self.seconds)
        return [{"res": {"rec_texts": ["KARAR"], "rec_scores": [0.9], "rec_boxes": [[0, 0, 4, 4]]}}]


class PageWindowTests(unittest.TestCase):
    """Sayfa dilimi sözleşmesi.

    Ölçüm: gerçek arşiv taramasında sayfa başına ~65 sn. Belgenin tamamını tek
    istekte işlemek 623 sayfalık bir dosyada 11 saat sürer ve istemci tavanı ne
    olursa olsun aşılır. Bu testler dilimin gerçekten sınırlı kaldığını ve
    kalan sayfanın bildirildiğini sabitler.
    """

    def setUp(self):
        self._engine = main._engine
        self._budget = main.REQUEST_BUDGET_SECONDS
        self._window = main.MAX_PAGES_PER_REQUEST
        self._lock_wait = main.LOCK_WAIT_SECONDS

    def tearDown(self):
        main._engine = self._engine
        main.REQUEST_BUDGET_SECONDS = self._budget
        main.MAX_PAGES_PER_REQUEST = self._window
        main.LOCK_WAIT_SECONDS = self._lock_wait

    def test_window_cap_limits_pages_and_reports_remainder(self):
        main._engine = FakeEngine()
        pages, next_page = main.predict_pages(FakeDocument(10), 10, first_page=1, window=3, started=time.perf_counter())
        self.assertEqual([page["pageNumber"] for page in pages], [1, 2, 3])
        self.assertEqual(next_page, 4, "kalan ilk sayfa bildirilmedi; belge yarıda kalırdı")

    def test_last_window_reports_no_remainder(self):
        main._engine = FakeEngine()
        pages, next_page = main.predict_pages(FakeDocument(5), 5, first_page=4, window=3, started=time.perf_counter())
        self.assertEqual([page["pageNumber"] for page in pages], [4, 5])
        self.assertIsNone(next_page, "belge bittiği hâlde kalan sayfa bildirildi")

    def test_budget_closes_the_window_early(self):
        """Bütçe dolduğunda dilim kapanır: terk edilmiş çıkarım kilidi tutmaz.

        Zaman aşımı servisi durdurmaz. Servis kendi bütçesini istemcinin
        tavanından kısa tutmazsa, istemci vazgeçtikten sonra çıkarım saatlerce
        sürer ve tek uçuşlu kilit yüzünden kuyruktaki bütün belgeler bekler.
        """
        main._engine = FakeEngine(seconds=0.05)
        main.REQUEST_BUDGET_SECONDS = 0.01
        pages, next_page = main.predict_pages(FakeDocument(20), 20, first_page=1, window=20, started=time.perf_counter())
        self.assertEqual(len(pages), 1, "bütçe dolmasına rağmen dilim büyümeye devam etti")
        self.assertEqual(next_page, 2)

    def test_every_request_advances_at_least_one_page(self):
        # Bütçe zaten aşılmış olsa bile en az bir sayfa işlenmelidir; aksi
        # halde iş hiç ilerlemeden sonsuza dek yeniden kuyruğa girer.
        main._engine = FakeEngine()
        main.REQUEST_BUDGET_SECONDS = 0.0
        pages, next_page = main.predict_pages(FakeDocument(3), 3, first_page=1, window=3,
                                              started=time.perf_counter() - 100)
        self.assertEqual(len(pages), 1)
        self.assertEqual(next_page, 2)

    def test_absolute_page_numbers_are_preserved(self):
        # Dilim numaraları belge genelinde mutlaktır; yeniden numaralandırma
        # sayfaların üst üste yazılmasına yol açardı.
        main._engine = FakeEngine()
        pages, _ = main.predict_pages(FakeDocument(30), 30, first_page=17, window=2, started=time.perf_counter())
        self.assertEqual([page["pageNumber"] for page in pages], [17, 18])

    def test_busy_predictor_fails_fast_instead_of_burning_the_budget(self):
        main._engine = FakeEngine()
        acquired = main._predict_lock.acquire(blocking=False)
        self.assertTrue(acquired, "test öncesi kilit doluysa ortam kirli demektir")
        try:
            main.LOCK_WAIT_SECONDS = 0.05
            with self.assertRaises(HTTPException) as raised:
                main.predict_pages(FakeDocument(3), 3, first_page=1, window=1, started=time.perf_counter())
            self.assertEqual(raised.exception.status_code, 503)
        finally:
            main._predict_lock.release()


class SingleFlightTests(unittest.TestCase):
    """Aynı belge için ikinci çıkarım reddedilir.

    Ölçümde aynı 389 MB dosya dört kez indirilmiş ve dört çıkarım başlamıştı:
    zaman aşımına düşen istek servisi durdurmadığı için her yeniden deneme
    kuyruğa yeni bir saatlik koşu ekliyordu.
    """

    def test_second_request_for_same_document_is_rejected(self):
        with main.single_flight("belge-1"):
            with self.assertRaises(HTTPException) as raised:
                with main.single_flight("belge-1"):
                    pass
            self.assertEqual(raised.exception.status_code, 409)

    def test_other_documents_are_not_blocked(self):
        with main.single_flight("belge-1"):
            with main.single_flight("belge-2"):
                pass

    def test_slot_is_released_after_failure(self):
        try:
            with main.single_flight("belge-3"):
                raise RuntimeError("çıkarım çöktü")
        except RuntimeError:
            pass
        # Çöken koşu yuvayı bırakmazsa belge bir daha hiç işlenemez.
        with main.single_flight("belge-3"):
            pass

    def test_guard_is_thread_safe(self):
        errors = []

        def attempt():
            try:
                with main.single_flight("belge-4"):
                    time.sleep(0.02)
            except HTTPException:
                errors.append(409)

        threads = [threading.Thread(target=attempt) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(errors), 3, "eşzamanlı isteklerden yalnız biri geçmeliydi")


if __name__ == "__main__":
    unittest.main()
