FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install --no-install-recommends -y clamav qpdf \
    && freshclam \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system scanner \
    && useradd --system --gid scanner --home-dir /opt/scanner --create-home scanner \
    && chown -R scanner:scanner /var/lib/clamav /opt/scanner

WORKDIR /service
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY app ./app
# İmza tazeliği çalışma zamanında freshclam ile korunur (entrypoint.sh);
# kapalı ağda FRESHCLAM_MIRROR kurum içi aynaya yöneltilir.
COPY entrypoint.sh /service/entrypoint.sh
RUN chmod +x /service/entrypoint.sh

USER scanner
EXPOSE 8091
ENTRYPOINT ["/service/entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8091/health',timeout=4)); raise SystemExit(0 if d.get('scannerReady') else 1)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8091"]
