from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .extractors import extract_fields
from .text_cleaner import readable_text

MAX_BYTES = 2 * 1024 * 1024 * 1024
ALLOWED_TYPES = {"application/pdf", "image/jpeg", "image/png", "image/tiff"}
_engine: Any | None = None
# Paddle öngörücüsü iş parçacığı güvenli değildir; çıkarım tek uçuşla sınırlanır.
# Uç sync olduğundan FastAPI onu havuzda koşturur ve kilit yalnız çıkarımı
# sıralar: sağlık ucu ve diğer istekler event loop'ta yanıt vermeye devam eder.
_predict_lock = threading.Lock()

"""İş birimi belge DEĞİL sayfa dilimidir (ADR-015 bölümleme desteğiyle aynı akıl).

Ölçüm: gerçek arşiv taramasında sayfa başına ~65 sn (Windows CPU, ısınmış
süreç). Belgenin tamamını tek istekte işlemek 623 sayfalık bir dosyada 11 saat
demektir; istemcinin tavanı ne olursa olsun aşılır. Bu yüzden her istek
SINIRLI bir sayfa penceresi işler ve kalan sayfayı `nextPage` ile bildirir.

`OCR_REQUEST_BUDGET_SECONDS` istemcinin tavanından KISA tutulmalıdır: servis
bütçesini aştığında elindeki sayfayı bitirip döner, böylece istemcinin çoktan
vazgeçtiği bir çıkarım kilidi saatlerce tutmaz. Terk edilmiş koşuların
kuyruğu zehirlemesi tam olarak bu sınırla engellenir.
"""
"""Gömülü metin katmanı kapısı: güvenilir katman varsa OCR HİÇ koşmaz.

Ölçüm (D:\\Arşiv, 12 sayfada katman ile gerçek OCR karşılaştırıldı): ayırt edici
sinyal Türkçe harf oranıdır. Gerçekten dijital üretilmiş sayfada bu oran ~%9 ve
metin OCR ile %70 örtüşüyor; eski bir OCR turundan gelen katmanlarda oran **%0**
ve `say1lt`, `Miidiirliigiinden` gibi rakam-harf karışmaları var. Kapı tüm arşivde
7.029 sayfanın 426'sını (%6,1) geçiriyor ve bunlar iki cilde toplanmıyor: aynı
yılın iki encümen cildinden biri %65,8 geçerken öbürü %0 geçiyor. Bu yüzden karar
cilt başına değil SAYFA başına verilir.

Kapıdan geçen sayfada güven 1,0 bildirilir: değer bir model tahmini değil,
belgenin kendi gömülü metnidir. Kapının işi tam olarak yalnız güvenilir katmanı
kabul etmektir. Sağlama yine personelde kalır — kritik alanlar profilde
`VERIFY_REQUIRED` olduğu için memur onayı olmadan belge arşive girmez.
"""
TEXT_LAYER_GATE = os.getenv("OCR_TEXT_LAYER_GATE", "true").strip().lower() == "true"
LAYER_MIN_WORDS = int(os.getenv("OCR_LAYER_MIN_WORDS", "40"))
LAYER_MIN_TR_RATIO = float(os.getenv("OCR_LAYER_MIN_TR_RATIO", "0.03"))
LAYER_MAX_MIXED_RATIO = float(os.getenv("OCR_LAYER_MAX_MIXED_RATIO", "0.02"))
TEXT_LAYER_MODEL = "pdf-text-layer"

MAX_PAGES_PER_REQUEST = max(1, int(os.getenv("OCR_MAX_PAGES_PER_REQUEST", "8")))
REQUEST_BUDGET_SECONDS = max(30.0, float(os.getenv("OCR_REQUEST_BUDGET_SECONDS", "240")))
PDF_RENDER_DPI = max(72, int(os.getenv("OCR_PDF_RENDER_DPI", "200")))
# Kilit başka bir belgede meşgulse hızlı 503: istemcinin bütçesini boş
# beklemeyle tüketmek, işi kuyrukta bırakmaktan daha kötüdür.
LOCK_WAIT_SECONDS = max(1.0, float(os.getenv("OCR_LOCK_WAIT_SECONDS", "15")))
ORIGINAL_CACHE_BYTES = max(0, int(os.getenv("OCR_ORIGINAL_CACHE_BYTES", str(6 * 1024 * 1024 * 1024))))

# Aynı belge için ikinci bir çıkarım başlatılmaz: yeniden deneme, süren koşunun
# arkasına yeni bir indirme + yeni bir çıkarım eklemekle kuyruğu kilitliyordu.
_active_documents: set[str] = set()
_active_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Üretim imajında modeli trafik kabul edilmeden önce belleğe alır ve ısıtır.

    Model dosyalarının yüklenmesi yetmez: ilk çıkarım oneDNN çekirdek
    derlemesini de öder ve gerçek bir belgede bu, işin zaman aşımı tavanını
    aşabilir (ölçüm: aynı görüntü soğuk süreçte 155 sn, ısınmış süreçte çok
    daha kısa). Isınma bedeli burada, servis trafiğe açılmadan önce ödenir;
    uvicorn lifespan bitmeden istek kabul etmediğinden sağlık ucu ancak
    ısınmış bir servis için "hazır" der.
    """
    if os.getenv("OCR_PRELOAD_MODEL", "false").lower() == "true":
        _warmup()
    yield


def _warmup() -> None:
    """Gerçek belge boyutunda sentetik bir görüntüyle tam bir çıkarım koşturur.

    oneDNN çekirdekleri girdi ŞEKLİNE özgü derlenir: minik bir görüntü yalnız
    minik şekillerin yolunu ısıtır ve ilk gerçek belge derleme bedelini yine
    öder. Görüntü bu yüzden tarama hattının gerçek çalışma boyutundadır —
    A4 oranında, uzun kenarı det sınırıyla (1600) aynı.
    """
    import numpy as np

    canvas = np.full((1600, 1131, 3), 255, dtype="uint8")
    try:
        import cv2

        for line in range(6):
            cv2.putText(canvas, "ISINMA CIKARIMI 2026", (80, 220 + line * 240),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 3)
    except Exception:
        pass  # Yazı çizilemese de boş görüntüyle çıkarım yine ısıtır.
    started = time.perf_counter()
    with _predict_lock:
        list(engine().predict(canvas))
    print(f"[ocr] isinma cikarimi {time.perf_counter() - started:.1f} sn surdu", flush=True)


app = FastAPI(title="Sivas Arşiv Yerel OCR", version="0.1.0", lifespan=lifespan)


def authorize(authorization: str | None = Header(default=None)) -> None:
    """Servis anahtarını doğrular; anahtar tanımlı değilse istek kabul edilmez.

    Önceki davranış anahtar tanımsızken ucu tamamen açık bırakıyordu: 8090 portu
    ağda görünen bir kurulumda herkes belge yükleyip OCR çalıştırabilirdi.
    Eksik yapılandırma açık kapı değil, açık hata üretmelidir.
    """
    token = os.getenv("OCR_SERVICE_TOKEN", "").strip()
    if not token:
        raise HTTPException(
            status_code=503,
            detail="OCR_SERVICE_TOKEN tanımlı değil; servis anahtarsız çalıştırılamaz",
        )
    if authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="Geçersiz OCR servis anahtarı")


MAX_PROFILE_BYTES = 256 * 1024


def parse_profile(raw: dict[str, Any] | str | None) -> dict[str, Any]:
    """Profil nesnesini boyut sınırıyla doğrular; servis kendi sözlüğünü uydurmaz."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        encoded = json.dumps(parsed, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Profil verisi geçerli JSON değil") from exc
    if len(encoded) > MAX_PROFILE_BYTES:
        raise HTTPException(status_code=413, detail="Profil verisi çok büyük")
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Profil verisi nesne olmalıdır")
    return parsed


def engine() -> Any:
    global _engine
    if _engine is None:
        try:
            from paddleocr import PaddleOCR
        except ImportError as exc:
            raise HTTPException(status_code=503, detail="PaddleOCR kurulmamış") from exc
        _engine = PaddleOCR(
            lang=os.getenv("PADDLEOCR_LANG", "tr"),
            ocr_version=os.getenv("PADDLEOCR_VERSION", "PP-OCRv5"),
            device=os.getenv("PADDLEOCR_DEVICE", "cpu"),
            enable_mkldnn=os.getenv("PADDLEOCR_ENABLE_MKLDNN", "false").lower() == "true",
            cpu_threads=int(os.getenv("PADDLEOCR_CPU_THREADS", "4")),
            text_det_limit_side_len=int(os.getenv("PADDLEOCR_DET_LIMIT_SIDE_LEN", "1600")),
            text_det_limit_type=os.getenv("PADDLEOCR_DET_LIMIT_TYPE", "max"),
            text_rec_score_thresh=float(os.getenv("PADDLEOCR_REC_SCORE_THRESH", "0.35")),
            use_doc_orientation_classify=True,
            use_doc_unwarping=True,
            use_textline_orientation=True,
        )
    return _engine


ACCESS_MAX_EDGE = int(os.getenv("ACCESS_DERIVATIVE_MAX_EDGE", "1600"))
ACCESS_QUALITY = int(os.getenv("ACCESS_DERIVATIVE_QUALITY", "72"))


def build_access_derivative(source_path: str, content_type: str) -> dict[str, Any] | None:
    """Görüntüleme türevini dosya yolundan üretir; ham aslı yeniden belleğe almaz."""
    if not content_type.startswith("image/"):
        return None
    try:
        import base64
        import cv2
        image = cv2.imread(source_path, cv2.IMREAD_COLOR)
        if image is None:
            return None
        height, width = image.shape[:2]
        longest = max(height, width)
        if longest > ACCESS_MAX_EDGE:
            scale = ACCESS_MAX_EDGE / longest
            image = cv2.resize(image, (max(1, int(width * scale)), max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
        encoded_ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, ACCESS_QUALITY])
        if not encoded_ok:
            return None
        payload = encoded.tobytes()
        return {"mediaType": "image/jpeg", "byteSize": len(payload), "base64": base64.b64encode(payload).decode("ascii")}
    except Exception:
        return None


def rectangular_box(poly: list[list[float]]) -> list[float]:
    return [min(point[0] for point in poly), min(point[1] for point in poly), max(point[0] for point in poly), max(point[1] for point in poly)]


def page_from_result(item: Any, page_number: int) -> dict[str, Any]:
    payload = item.json if hasattr(item, "json") else item
    result = payload.get("res", payload)
    texts = result.get("rec_texts", [])
    scores = result.get("rec_scores", [])
    boxes = result.get("rec_boxes") or []
    if not boxes:
        boxes = [rectangular_box(poly) for poly in result.get("rec_polys", [])]
    words = []
    for text, score, box in zip(texts, scores, boxes):
        value = str(text).strip()
        if value:
            words.append({"text": value, "confidence": float(score), "box": [float(v) for v in box]})
    width = max((word["box"][2] for word in words), default=1.0)
    height = max((word["box"][3] for word in words), default=1.0)
    average = sum(word["confidence"] for word in words) / len(words) if words else 0.0
    raw_text = "\n".join(word["text"] for word in words)
    # Aranabilir biçim uygulama katmanında üretilir (`lib/text-search.ts`).
    # Sorgu ve dizin aynı fonksiyondan geçmezse eşleşmeler sessizce kaçar.
    return {
        "pageNumber": page_number,
        "width": int(width),
        "height": int(height),
        "rawText": raw_text,
        "fullText": readable_text(words),
        "averageConfidence": round(average, 4),
        "words": words,
    }


def prepare_image(source_path: str, content_type: str) -> tuple[str, bool, int | None, int | None, dict[str, float], str | None]:
    """Görüntüyü ham dosyayı ikinci kez belleğe almadan dosya yolundan hazırlar."""
    if not content_type.startswith("image/"):
        return source_path, False, None, None, {}, None
    try:
        import cv2
        image = cv2.imread(source_path, cv2.IMREAD_COLOR)
        if image is None:
            return source_path, False, None, None, {}, None
        height, width = image.shape[:2]
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        # Ölçüt ve iyileştirme PDF sayfalarıyla ORTAK: iki yolda farklı eşik
        # kullanılırsa aynı tarama biçimine göre farklı okunur.
        metrics, should_enhance = quality_metrics(gray)
        if not should_enhance:
            return source_path, False, width, height, metrics, None
        enhanced = enhance_gray(gray)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as generated:
            generated_path = generated.name
        if not cv2.imwrite(generated_path, enhanced, [cv2.IMWRITE_PNG_COMPRESSION, 3]):
            Path(generated_path).unlink(missing_ok=True)
            return source_path, False, width, height, metrics, None
        return generated_path, True, width, height, metrics, generated_path
    except Exception:
        return source_path, False, None, None, {}, None


class OcrObjectRequest(BaseModel):
    documentId: str
    objectKey: str
    mediaType: str
    byteSize: int = Field(gt=0, le=MAX_BYTES)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    profile: dict[str, Any] = Field(default_factory=dict)
    # Sayfa dilimi: 1 tabanlı ilk sayfa ve pencere üst sınırı. Belirtilmezse
    # baştan başlanır ve sunucu penceresi uygulanır.
    pageFrom: int = Field(default=1, ge=1)
    maxPages: int | None = Field(default=None, ge=1)


@contextmanager
def single_flight(document_id: str):
    """Aynı belge için eşzamanlı ikinci çıkarımı reddeder.

    Zaman aşımına düşen bir istek servisi durdurmaz. Yeniden deneme aynı belge
    için ikinci bir indirme ve ikinci bir çıkarım başlatırsa, tek uçuşlu Paddle
    kilidi yüzünden kuyruktaki BÜTÜN belgeler bekler. İş hâlâ sürüyorsa çağıran
    409 alır ve işi kuyrukta bırakır.
    """
    with _active_lock:
        if document_id in _active_documents:
            raise HTTPException(status_code=409, detail="Bu belge için OCR çıkarımı hâlihazırda sürüyor")
        _active_documents.add(document_id)
    try:
        yield
    finally:
        with _active_lock:
            _active_documents.discard(document_id)


def _cache_directory() -> Path:
    configured = os.getenv("OCR_ORIGINAL_CACHE_DIR", "").strip()
    directory = Path(configured) if configured else Path(tempfile.gettempdir()) / "sivas-ocr-originals"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _prune_cache(directory: Path, keep: Path) -> None:
    """Önbelleği bayt sınırında tutar; en eski dokunulan dosya ilk düşer."""
    entries = []
    total = 0
    for path in directory.iterdir():
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        total += stat.st_size
        entries.append((stat.st_mtime, stat.st_size, path))
    entries.sort()
    for _, size, path in entries:
        if total <= ORIGINAL_CACHE_BYTES:
            break
        if path == keep:
            continue
        try:
            path.unlink()
            total -= size
        except OSError:
            # Başka bir istek dosyayı açık tutuyorsa Windows silmeyi reddeder;
            # sonraki turda yeniden denenir.
            continue


def cached_original(reference: OcrObjectRequest, suffix: str) -> str:
    """Aslı servise özel önbellekten verir, yoksa doğrulayarak indirir.

    Sayfa dilimleri aynı belgeyi tekrar tekrar işler. Önbellek olmadan her
    dilim yüz megabaytlık aslı yeniden indirirdi: ölçümde aynı 389 MB dosyanın
    dört kopyası geçici dizinde birikmişti. Dosya adı yetkili SHA-256'dır ve
    içerik indirme sırasında doğrulanır; önbellek isabetinde boyut denetlenir.
    """
    directory = _cache_directory()
    target = directory / f"{reference.sha256}{suffix}"
    if target.exists() and target.stat().st_size == reference.byteSize:
        os.utime(target, None)
        return str(target)
    with tempfile.NamedTemporaryFile(delete=False, dir=directory, suffix=suffix) as staging:
        staging_path = staging.name
    try:
        download_original(reference, staging_path)
        os.replace(staging_path, target)
    except BaseException:
        Path(staging_path).unlink(missing_ok=True)
        raise
    _prune_cache(directory, target)
    return str(target)


def quality_metrics(gray: Any) -> tuple[dict[str, float], bool]:
    """Soluk tarama ölçütü: parlaklık yüksek, kontrast aralığı dar.

    Gerçek siyah-beyaz taramalar (`uniqueLevels` küçük) gereksiz yeniden
    işlemden korunur; ölçümde bu varyant güveni düşürüyordu.
    """
    import numpy as np

    mean = float(gray.mean())
    p05 = float(np.percentile(gray, 5))
    p95 = float(np.percentile(gray, 95))
    contrast_span = p95 - p05
    unique_levels = int(np.unique(gray).size)
    mode = os.getenv("PADDLEOCR_PREPROCESS", "auto").strip().lower()
    is_bilevel = unique_levels <= 8
    should_enhance = mode == "always" or (mode == "auto" and not is_bilevel and mean > 210 and contrast_span < 80)
    metrics = {"mean": round(mean, 2), "contrastSpan": round(contrast_span, 2), "uniqueLevels": unique_levels}
    return metrics, should_enhance


def enhance_gray(gray: Any) -> Any:
    """CLAHE + keskinleştirme; seçilen en iyi varyant (OCR_TEST_RAPORU.md)."""
    import cv2

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    blurred = cv2.GaussianBlur(clahe, (0, 0), 1.0)
    return cv2.addWeighted(clahe, 1.55, blurred, -0.55, 0)


_TR_LETTERS = set("çğıöşüÇĞİÖŞÜ")
_LAYER_WORD = re.compile(r"[0-9A-Za-zÇĞİÖŞÜçğıöşü]+")


def layer_quality(text: str) -> tuple[dict[str, float], bool]:
    """Gömülü katmanın güvenilir olup olmadığına karar verir.

    Üç ölçüt: yeterli kelime, Türkçe harf varlığı ve rakam-harf karışmasının
    yokluğu. İkincisi belirleyicidir — Türkçe dil modeli olmayan eski bir OCR
    turu diakritikleri tümüyle düşürür ve oran sıfırlanır.
    """
    letters = [character for character in text if character.isalpha()]
    words = _LAYER_WORD.findall(text)
    if len(words) < LAYER_MIN_WORDS or not letters:
        return {"words": len(words), "trRatio": 0.0, "mixedRatio": 0.0}, False
    tr_ratio = sum(1 for character in letters if character in _TR_LETTERS) / len(letters)
    mixed = [
        word for word in words
        if len(word) > 2 and any(c.isdigit() for c in word) and any(c.isalpha() for c in word)
    ]
    mixed_ratio = len(mixed) / len(words)
    metrics = {
        "words": len(words),
        "trRatio": round(tr_ratio, 4),
        "mixedRatio": round(mixed_ratio, 4),
    }
    return metrics, tr_ratio > LAYER_MIN_TR_RATIO and mixed_ratio < LAYER_MAX_MIXED_RATIO


def layer_page(document: Any, page_number: int, dpi: int) -> dict[str, Any] | None:
    """Katman güvenilirse sayfayı OCR ÇALIŞTIRMADAN üretir; değilse `None`.

    Satır bazlı gruplanır: OCR yolu da satır düzeyinde `words` döndürür, kanıt
    kırpmaları bu yüzden iki yolda aynı biçimde görünür. Kutular PDF
    noktasından, OCR yolunun kullandığı render piksel uzayına çevrilir (y ekseni
    ters çevrilir) — aksi hâlde inceleme ekranındaki kanıt kırpması kayar.
    """
    page = document[page_number - 1]
    textpage = page.get_textpage()
    try:
        count = textpage.count_chars()
        if not count:
            return None
        text = textpage.get_text_range(0, count)
        metrics, passed = layer_quality(text)
        if not passed:
            return None

        _, height_points = page.get_size()
        scale = dpi / 72
        words: list[dict[str, Any]] = []
        start = 0
        for raw_line in text.splitlines():
            line = raw_line.strip()
            span = len(raw_line)
            if line:
                boxes = []
                for index in range(start, min(start + span, count)):
                    try:
                        left, bottom, right, top = textpage.get_charbox(index)
                    except Exception:  # noqa: BLE001 — boşluk karakterinde kutu olmayabilir
                        continue
                    if right > left and top > bottom:
                        boxes.append((left, bottom, right, top))
                if boxes:
                    words.append({
                        "text": line,
                        # Katman metni model tahmini değil, belgenin kendi metni.
                        "confidence": 1.0,
                        "box": [
                            round(min(b[0] for b in boxes) * scale, 1),
                            round((height_points - max(b[3] for b in boxes)) * scale, 1),
                            round(max(b[2] for b in boxes) * scale, 1),
                            round((height_points - min(b[1] for b in boxes)) * scale, 1),
                        ],
                    })
            # +1: splitlines ayırıcıyı düşürür, karakter dizininde ise yer tutar.
            start += span + 1
        if not words:
            return None
        raw_text = "\n".join(word["text"] for word in words)
        return {
            "pageNumber": page_number,
            "width": int(page.get_size()[0] * scale),
            "height": int(height_points * scale),
            "rawText": raw_text,
            "fullText": readable_text(words),
            "averageConfidence": 1.0,
            "words": words,
            "model": TEXT_LAYER_MODEL,
            "layerMetrics": metrics,
        }
    finally:
        textpage.close()


def render_pdf_page(document: Any, page_number: int) -> tuple[Any, bool, dict[str, float]]:
    """PDF sayfasını çıkarım için hazırlar (pdfium, 1 tabanlı sayfa).

    İyileştirme burada da uygulanır. Eski kodda `prepare_image` yalnız
    `image/*` yüklemelerinde çalışıyordu ve PDF yolu hemen dönüyordu: soluk
    1975/1983 taramaları — CLAHE'nin asıl hedefi — hiç iyileştirilmiyordu,
    oysa arşivin tamamı PDF olarak geliyor.
    """
    import numpy as np

    page = document[page_number - 1]
    bitmap = page.render(scale=PDF_RENDER_DPI / 72)
    array = bitmap.to_numpy()
    if array.ndim == 3 and array.shape[2] >= 3:
        # pdfium RGB verir; Paddle cv2 düzeninde (BGR) bekler.
        array = array[:, :, 2::-1]
    array = np.ascontiguousarray(array)
    try:
        import cv2
        gray = cv2.cvtColor(array, cv2.COLOR_BGR2GRAY) if array.ndim == 3 else array
        metrics, should_enhance = quality_metrics(gray)
        if should_enhance:
            # Üç kanala geri çevrilir: Paddle'ın belge düzeltme ön işlemcisi
            # `img.shape[2]` okur ve tek kanallı dizide IndexError ile çöker.
            # Eski yol iyileştirilmiş görüntüyü PNG olarak yazdığı için bu
            # dönüşüm dosya okumada örtük yapılıyordu.
            enhanced = cv2.cvtColor(enhance_gray(gray), cv2.COLOR_GRAY2BGR)
            return np.ascontiguousarray(enhanced), True, metrics
        return array, False, metrics
    except Exception:
        # İyileştirme bir kolaylıktır; başarısız olursa ham sayfa işlenir.
        return array, False, {}


def predict_pages(document: Any, page_count: int, first_page: int, window: int, started: float) -> tuple[list[dict[str, Any]], int | None, bool, int]:
    """Sayfa penceresini işler; bütçe dolduğunda kalan ilk sayfayı bildirir.

    Kilit pencerenin tamamı için BİR kez alınır: pencere kısa olduğundan bu
    diğer belgeleri uzun süre bekletmez, sayfa başına yeniden kilitlenmek ise
    dilimin ortasında uzun bir bekleme riski yaratır.
    """
    """Kapıdan geçen sayfalar çıkarım kilidini HİÇ almaz.

    Katman okuması milisaniye mertebesindedir; onu tek uçuşlu kilidin arkasına
    koymak, kuyruktaki başka belgeleri bedelsiz biçimde bekletirdi. Kilit bu
    yüzden ilk gerçek çıkarıma kadar alınmaz.
    """
    pages: list[dict[str, Any]] = []
    enhanced_any = False
    layer_pages = 0
    locked = False
    try:
        for offset in range(window):
            number = first_page + offset
            if number > page_count:
                break
            if TEXT_LAYER_GATE:
                from_layer = layer_page(document, number, PDF_RENDER_DPI)
                if from_layer:
                    pages.append(from_layer)
                    layer_pages += 1
                    continue
            if not locked:
                if not _predict_lock.acquire(timeout=LOCK_WAIT_SECONDS):
                    raise HTTPException(status_code=503, detail="OCR çıkarımı başka bir belgeyle meşgul; iş kuyrukta kalmalı")
                locked = True
            image, enhanced, _ = render_pdf_page(document, number)
            enhanced_any = enhanced_any or enhanced
            predictions = list(engine().predict(image))
            page = page_from_result(predictions[0], number) if predictions else {
                "pageNumber": number, "width": 0, "height": 0, "rawText": "",
                "fullText": "", "averageConfidence": 0.0, "words": [],
            }
            page["height"], page["width"] = int(image.shape[0]), int(image.shape[1])
            pages.append(page)
            # Bütçe denetimi sayfa BİTTİKTEN sonra yapılır: yarım sayfa
            # sonucu yoktur ve her istek en az bir sayfa ilerlemek zorundadır,
            # aksi halde iş hiç ilerlemeden sonsuza dek yeniden kuyruğa girer.
            if time.perf_counter() - started >= REQUEST_BUDGET_SECONDS:
                break
    finally:
        if locked:
            _predict_lock.release()
    served_to = first_page + len(pages) - 1
    return pages, (served_to + 1 if served_to < page_count else None), enhanced_any, layer_pages


def _verified_copy(reference: OcrObjectRequest, body: Any, destination: str) -> None:
    """Kaynaktan bağımsız ortak güvence: boyut ve SHA-256 yeniden doğrulanır."""
    digest = hashlib.sha256()
    written = 0
    try:
        with open(destination, "wb") as output:
            while True:
                chunk = body.read(8 * 1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > reference.byteSize or written > MAX_BYTES:
                    raise HTTPException(status_code=413, detail="Nesne boyut sınırını aşıyor")
                digest.update(chunk)
                output.write(chunk)
    finally:
        body.close()
    if written != reference.byteSize or digest.hexdigest() != reference.sha256:
        raise HTTPException(status_code=422, detail="Nesne SHA-256 doğrulaması başarısız")


def download_original(reference: OcrObjectRequest, destination: str) -> None:
    """Aslı sabit kovadan salt-okunur kimlikle ve sınırlı parçalarla indirir."""
    if not reference.objectKey.startswith("originals/") or ".." in reference.objectKey.split("/"):
        raise HTTPException(status_code=400, detail="Geçersiz asıl nesne anahtarı")

    # YALNIZ YEREL GELİŞTİRME: Miniflare R2'nin S3 ucu yok; OCR_FETCH_URL
    # tanımlıysa asıl, uygulamanın iç ucundan indirilir. Boyut ve SHA-256
    # doğrulaması S3 yoluyla birebir aynıdır; üretimde bu değişken tanımlanmaz
    # ve aşağıdaki S3 yolu tek yol olarak kalır (ADR-014).
    fetch_url = os.getenv("OCR_FETCH_URL", "").strip()
    if fetch_url:
        from urllib import parse, request as urlrequest
        query = parse.urlencode({"scope": "original", "key": reference.objectKey})
        http_request = urlrequest.Request(
            f"{fetch_url.rstrip('/')}?{query}",
            headers={"Authorization": f"Bearer {os.getenv('OCR_SERVICE_TOKEN', '').strip()}"},
        )
        try:
            response = urlrequest.urlopen(http_request, timeout=60)
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Asıl nesne yerel uçtan alınamadı") from exc
        _verified_copy(reference, response, destination)
        return

    bucket = os.getenv("OCR_ORIGINAL_BUCKET", "").strip()
    endpoint = os.getenv("OCR_S3_ENDPOINT_URL", "").strip() or None
    if not bucket:
        raise HTTPException(status_code=503, detail="OCR_ORIGINAL_BUCKET tanımlı değil")
    try:
        import boto3
        client = boto3.client("s3", endpoint_url=endpoint)
        response = client.get_object(Bucket=bucket, Key=reference.objectKey)
        reported_size = int(response.get("ContentLength", -1))
        if reported_size != reference.byteSize:
            raise HTTPException(status_code=422, detail="Nesne boyutu yetkili kayıtla eşleşmiyor")
        _verified_copy(reference, response["Body"], destination)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Asıl nesne salt-okunur depodan alınamadı") from exc


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {
        "status": "ok",
        "engine": "PaddleOCR",
        "model": os.getenv("PADDLEOCR_VERSION", "PP-OCRv5"),
        "modelReady": _engine is not None,
        "device": os.getenv("PADDLEOCR_DEVICE", "cpu"),
    }


@app.post("/v1/ocr", dependencies=[Depends(authorize)])
def run_ocr(reference: OcrObjectRequest) -> dict[str, Any]:
    """OCR isteğini işler; uç BİLEREK sync tanımlıdır.

    Önceki tanım `async def` idi ve bloklayan indirme + Paddle çıkarımı doğrudan
    event loop üzerinde koşuyordu: çıkarım sürerken /health dahil hiçbir istek
    yanıt alamıyordu. İşletimde bunun anlamı, uzun bir belge işlenirken canlılık
    sondasının servisi "ölü" sayıp kapatmasıdır. Sync uç FastAPI'nin iş parçacığı
    havuzunda koşar; sağlık ucu her zaman yanıt verir, çıkarım ise aşağıdaki
    kilitle tek uçuşa sıralanır (Paddle öngörücüsü iş parçacığı güvenli değildir
    ve eşzamanlı iki çıkarım CPU'yu ezip ikisini de zaman aşımına sürükler).

    İş birimi belgenin tamamı değil bir SAYFA DİLİMİdir: yanıt işlenen aralığı
    ve varsa kalan ilk sayfayı (`nextPage`) bildirir. Çağıran dilimleri
    sırayla ister; hiçbir istek istemcinin tavanını aşacak kadar uzun sürmez.
    """
    document_profile = parse_profile(reference.profile)
    if reference.mediaType not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Desteklenmeyen dosya türü")
    suffix = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/tiff": ".tiff"}[reference.mediaType]
    started = time.perf_counter()
    base_model = os.getenv("PADDLEOCR_VERSION", "PP-OCRv5")
    with single_flight(reference.documentId):
        source_path = cached_original(reference, suffix)
        if reference.mediaType == "application/pdf":
            pages, next_page, page_count, enhanced, layer_pages = ocr_pdf_window(reference, source_path, started)
            return {
                "engine": "PaddleOCR",
                "model": f"{base_model}+clahe-auto" if enhanced else base_model,
                "durationMs": int((time.perf_counter() - started) * 1000),
                "documentId": reference.documentId,
                "preprocessing": {"enhanced": enhanced, "renderDpi": PDF_RENDER_DPI,
                                  "textLayerPages": layer_pages, "ocrPages": len(pages) - layer_pages},
                "profileVersion": document_profile.get("profileVersion"),
                "vocabularyVersion": document_profile.get("vocabularyVersion"),
                "accessDerivative": None,
                "pageCount": page_count,
                "pageFrom": reference.pageFrom,
                "pageTo": reference.pageFrom + len(pages) - 1 if pages else reference.pageFrom - 1,
                "nextPage": next_page,
                "pages": pages, "fields": extract_fields(pages, document_profile),
            }

        generated_path: str | None = None
        try:
            processing_path, enhanced, image_width, image_height, quality, generated_path = prepare_image(source_path, reference.mediaType)
            # `predict` üreteçtir; asıl hesap yineleme sırasında koşar. Kilit bu
            # yüzden yalnız çağrıyı değil, tüketimi de kapsar.
            if not _predict_lock.acquire(timeout=LOCK_WAIT_SECONDS):
                raise HTTPException(status_code=503, detail="OCR çıkarımı başka bir belgeyle meşgul; iş kuyrukta kalmalı")
            try:
                predictions = list(engine().predict(processing_path))
            finally:
                _predict_lock.release()
            pages = [page_from_result(item, index + 1) for index, item in enumerate(predictions)]
            if len(pages) == 1 and image_width and image_height:
                pages[0]["width"] = image_width
                pages[0]["height"] = image_height
            return {
                "engine": "PaddleOCR",
                "model": f"{base_model}+clahe-auto" if enhanced else base_model,
                "durationMs": int((time.perf_counter() - started) * 1000),
                "documentId": reference.documentId,
                "preprocessing": {"enhanced": enhanced, **quality},
                "profileVersion": document_profile.get("profileVersion"),
                "vocabularyVersion": document_profile.get("vocabularyVersion"),
                "accessDerivative": build_access_derivative(source_path, reference.mediaType),
                # Görüntü tek sayfadır: dilimleme yoktur, kalan sayfa yoktur.
                "pageCount": len(pages) or 1, "pageFrom": 1,
                "pageTo": len(pages) or 1, "nextPage": None,
                "pages": pages, "fields": extract_fields(pages, document_profile),
            }
        finally:
            if generated_path:
                Path(generated_path).unlink(missing_ok=True)


def ocr_pdf_window(reference: OcrObjectRequest, source_path: str, started: float) -> tuple[list[dict[str, Any]], int | None, int, bool, int]:
    """PDF'in istenen sayfa dilimini işler.

    (sayfalar, kalan ilk sayfa, toplam sayfa, iyileştirme, katmandan gelen sayfa) döner.
    """
    try:
        import pypdfium2
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="pypdfium2 kurulmamış; PDF sayfası işlenemez") from exc
    document = pypdfium2.PdfDocument(source_path)
    try:
        page_count = len(document)
        if page_count < 1:
            raise HTTPException(status_code=422, detail="Belgede işlenebilir sayfa yok")
        if reference.pageFrom > page_count:
            raise HTTPException(status_code=400, detail=f"İstenen sayfa {reference.pageFrom}, belge {page_count} sayfa")
        window = min(reference.maxPages or MAX_PAGES_PER_REQUEST, MAX_PAGES_PER_REQUEST)
        pages, next_page, enhanced, layer_pages = predict_pages(document, page_count, reference.pageFrom, window, started)
        return pages, next_page, page_count, enhanced, layer_pages
    finally:
        document.close()