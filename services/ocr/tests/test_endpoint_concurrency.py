import inspect
import unittest

from app import main


class EndpointConcurrencyTests(unittest.TestCase):
    """OCR ucunun eşzamanlılık sözleşmesi.

    Uç bir dönem `async def` idi ve bloklayan Paddle çıkarımı doğrudan event
    loop üzerinde koşuyordu: çıkarım sürerken /health dahil hiçbir istek yanıt
    alamıyordu. İşletimde bu, uzun bir belge işlenirken canlılık sondasının
    servisi "ölü" sayıp kapatması demektir. Bu testler o sözleşmeyi sabitler;
    biri kırılırsa kusur aynen geri gelir.
    """

    def test_run_ocr_is_sync_so_it_runs_off_the_event_loop(self):
        # Sync uç FastAPI'nin iş parçacığı havuzunda koşar; async'e çevrilirse
        # bloklayan çıkarım yine event loop'u kilitler.
        self.assertFalse(inspect.iscoroutinefunction(main.run_ocr),
                         "run_ocr async tanımlanmış: bloklayan çıkarım event loop'u kilitler")

    def test_health_stays_answerable_while_inference_lock_is_held(self):
        # Çıkarım kilidi doluyken sağlık ucu yanıt vermeye devam etmelidir;
        # sağlık, kilidi paylaşsaydı sonda yine zaman aşımına düşerdi.
        acquired = main._predict_lock.acquire(blocking=False)
        self.assertTrue(acquired, "test öncesi kilit doluysa ortam kirli demektir")
        try:
            payload = main.health()
            self.assertEqual(payload["status"], "ok")
        finally:
            main._predict_lock.release()


if __name__ == "__main__":
    unittest.main()
