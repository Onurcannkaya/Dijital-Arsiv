# ADR-015: bağımlılıklar sabittir; registry digest'i dağıtımda
# RENDERER_IMAGE_DIGEST olarak enjekte edilir ve Worker tarafından doğrulanır.
FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /srv/render

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --system --home /srv/render render \
    && chown -R render:render /srv/render
USER render

# Dış ağ erişimi dağıtımda kapatılır; yalnız nesne deposu uç noktası açık kalır.
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=4)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
