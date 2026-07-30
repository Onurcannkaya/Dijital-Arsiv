from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .extractors import extract_fields
from .text_cleaner import readable_text

MAX_BYTES = 2 * 1024 * 1024 * 1024
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
        import numpy as np
        image = cv2.imread(source_path, cv2.IMREAD_COLOR)
        if image is None:
            return source_path, False, None, None, {}, None
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
            return source_path, False, width, height, metrics, None
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        blurred = cv2.GaussianBlur(clahe, (0, 0), 1.0)
        enhanced = cv2.addWeighted(clahe, 1.55, blurred, -0.55, 0)
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


def download_original(reference: OcrObjectRequest, destination: str) -> None:
    """Aslı sabit kovadan salt-okunur kimlikle ve sınırlı parçalarla indirir."""
    bucket = os.getenv("OCR_ORIGINAL_BUCKET", "").strip()
    endpoint = os.getenv("OCR_S3_ENDPOINT_URL", "").strip() or None
    if not bucket:
        raise HTTPException(status_code=503, detail="OCR_ORIGINAL_BUCKET tanımlı değil")
    if not reference.objectKey.startswith("originals/") or ".." in reference.objectKey.split("/"):
        raise HTTPException(status_code=400, detail="Geçersiz asıl nesne anahtarı")
    try:
        import boto3
        client = boto3.client("s3", endpoint_url=endpoint)
        response = client.get_object(Bucket=bucket, Key=reference.objectKey)
        reported_size = int(response.get("ContentLength", -1))
        if reported_size != reference.byteSize:
            raise HTTPException(status_code=422, detail="Nesne boyutu yetkili kayıtla eşleşmiyor")
        body = response["Body"]
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
async def run_ocr(reference: OcrObjectRequest) -> dict[str, Any]:
    document_profile = parse_profile(reference.profile)
    if reference.mediaType not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Desteklenmeyen dosya türü")
    suffix = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/tiff": ".tiff"}[reference.mediaType]
    started = time.perf_counter()
    source_path: str | None = None
    generated_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temporary:
            source_path = temporary.name
        download_original(reference, source_path)
        processing_path, enhanced, image_width, image_height, quality, generated_path = prepare_image(source_path, reference.mediaType)
        predictions = engine().predict(processing_path)
        pages = [page_from_result(item, index + 1) for index, item in enumerate(predictions)]
        if len(pages) == 1 and image_width and image_height:
            pages[0]["width"] = image_width
            pages[0]["height"] = image_height
        fields = extract_fields(pages, document_profile)
        base_model = os.getenv("PADDLEOCR_VERSION", "PP-OCRv5")
        model = f"{base_model}+clahe-auto" if enhanced else base_model
        return {
            "engine": "PaddleOCR", "model": model,
            "durationMs": int((time.perf_counter() - started) * 1000),
            "documentId": reference.documentId,
            "preprocessing": {"enhanced": enhanced, **quality},
            "profileVersion": document_profile.get("profileVersion"),
            "vocabularyVersion": document_profile.get("vocabularyVersion"),
            "accessDerivative": build_access_derivative(source_path, reference.mediaType),
            "pages": pages, "fields": fields,
        }
    finally:
        if generated_path:
            Path(generated_path).unlink(missing_ok=True)
        if source_path:
            Path(source_path).unlink(missing_ok=True)