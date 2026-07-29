from __future__ import annotations

import json
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile

from .extractors import extract_fields
from .text_cleaner import readable_text

MAX_BYTES = 25 * 1024 * 1024
ALLOWED_TYPES = {"application/pdf", "image/jpeg", "image/png", "image/tiff"}
_engine: Any | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Üretim imajında modeli trafik kabul edilmeden önce belleğe alır."""
    if os.getenv("OCR_PRELOAD_MODEL", "false").lower() == "true":
        engine()
    yield


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


def parse_profile(raw: str | None) -> dict[str, Any]:
    """Uygulamadan gelen belge türü profilini ayrıştırır.

    Müdürlük ve belge türü sözlükleri istekle taşınır; servis kendi listesini
    tutmaz. Bozuk veya aşırı büyük profil sessizce yok sayılmaz, açık hata verir:
    eksik sözlükle çalışmak alanların sessizce kaybolmasına yol açar.
    """
    if not raw:
        return {}
    if len(raw.encode("utf-8")) > MAX_PROFILE_BYTES:
        raise HTTPException(status_code=413, detail="Profil verisi çok büyük")
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Profil verisi geçerli JSON değil") from exc
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


def build_access_derivative(content: bytes, content_type: str) -> dict[str, Any] | None:
    """Görüntüleme için kontrollü erişim türevi üretir.

    Asıl dosya (değiştirilemez asıl) yalnız indirme yetkisiyle sunulmalıdır;
    görüntüleme bu türevi alır (S3_DEPOLAMA_VE_DEGISMEZLIK_POLITIKASI.md §5).
    Türev burada üretilir çünkü servis görüntüyü OCR için zaten çözüyor.

    PDF için türev üretilmez: servis PDF sayfası çizdirecek bir bileşen
    içermiyor. `None` dönmesi, uygulamanın bu belgede türev bulunmadığını
    bilmesini ve durumu raporlamasını sağlar.
    """
    if not content_type.startswith("image/"):
        return None
    try:
        import base64

        import cv2
        import numpy as np

        image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
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
        return {
            "mediaType": "image/jpeg",
            "byteSize": len(payload),
            "base64": base64.b64encode(payload).decode("ascii"),
        }
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


def prepare_image(content: bytes, content_type: str) -> tuple[bytes, bool, int | None, int | None, dict[str, float]]:
    if not content_type.startswith("image/"):
        return content, False, None, None, {}
    try:
        import cv2
        import numpy as np

        image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            return content, False, None, None, {}
        height, width = image.shape[:2]
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        mean = float(gray.mean())
        p05 = float(np.percentile(gray, 5))
        p95 = float(np.percentile(gray, 95))
        contrast_span = p95 - p05
        unique_levels = int(np.unique(gray).size)
        mode = os.getenv("PADDLEOCR_PREPROCESS", "auto").strip().lower()
        is_bilevel = unique_levels <= 8
        should_enhance = mode == "always" or (mode == "auto" and not is_bilevel and mean > 210 and contrast_span < 80)
        metrics = {"mean": round(mean, 2), "contrastSpan": round(contrast_span, 2), "uniqueLevels": unique_levels}
        if not should_enhance:
            return content, False, width, height, metrics
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        blurred = cv2.GaussianBlur(clahe, (0, 0), 1.0)
        enhanced = cv2.addWeighted(clahe, 1.55, blurred, -0.55, 0)
        encoded_ok, encoded = cv2.imencode(".png", enhanced, [cv2.IMWRITE_PNG_COMPRESSION, 3])
        if not encoded_ok:
            return content, False, width, height, metrics
        return encoded.tobytes(), True, width, height, metrics
    except Exception:
        return content, False, None, None, {}

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
async def run_ocr(
    file: UploadFile = File(...),
    documentId: str | None = None,
    profile: str | None = Form(default=None),
) -> dict[str, Any]:
    document_profile = parse_profile(profile)
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Desteklenmeyen dosya türü")
    content = await file.read(MAX_BYTES + 1)
    if not content or len(content) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Dosya boş veya 25 MB sınırını aşıyor")
    suffix = Path(file.filename or "belge").suffix or ".bin"
    processed_content, enhanced, image_width, image_height, quality = prepare_image(content, file.content_type or "")
    if enhanced:
        suffix = ".png"
    started = time.perf_counter()
    path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temporary:
            temporary.write(processed_content)
            path = temporary.name
        predictions = engine().predict(path)
        pages = [page_from_result(item, index + 1) for index, item in enumerate(predictions)]
        if len(pages) == 1 and image_width and image_height:
            pages[0]["width"] = image_width
            pages[0]["height"] = image_height
        fields = extract_fields(pages, document_profile)
        base_model = os.getenv("PADDLEOCR_VERSION", "PP-OCRv5")
        model = f"{base_model}+clahe-auto" if enhanced else base_model
        return {
            "engine": "PaddleOCR",
            "model": model,
            "durationMs": int((time.perf_counter() - started) * 1000),
            "documentId": documentId,
            "preprocessing": {"enhanced": enhanced, **quality},
            # Hangi profil ve sözlük sürümüyle çıkarım yapıldığı sonuçla saklanır.
            "profileVersion": document_profile.get("profileVersion"),
            "vocabularyVersion": document_profile.get("vocabularyVersion"),
            # Görüntüleme türevi; PDF'lerde `None` döner.
            "accessDerivative": build_access_derivative(content, file.content_type or ""),
            "pages": pages,
            "fields": fields,
        }
    finally:
        if path:
            Path(path).unlink(missing_ok=True)
