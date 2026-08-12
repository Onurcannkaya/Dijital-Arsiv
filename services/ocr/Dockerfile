FROM python:3.11-slim

ARG PADDLEOCR_VERSION=PP-OCRv5
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/opt/ocr \
    PADDLEOCR_DEVICE=cpu \
    PADDLEOCR_VERSION=${PADDLEOCR_VERSION} \
    OCR_PRELOAD_MODEL=true

RUN apt-get update \
    && apt-get install --no-install-recommends -y libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system ocr \
    && useradd --system --gid ocr --home-dir /opt/ocr --create-home ocr

WORKDIR /service
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY scripts/download_models.py ./scripts/download_models.py

# Paddle modellerini derleme sırasında indirir. Çalışma zamanı internet erişimine
# ihtiyaç duymaz; model sürümü imaj etiketi ve PADDLEOCR_VERSION ile izlenebilir.
RUN python ./scripts/download_models.py \
    && chown -R ocr:ocr /opt/ocr /service

USER ocr
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["python", "-c", "import json,urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4)); raise SystemExit(0 if data.get('status') == 'ok' and data.get('modelReady') else 1)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
