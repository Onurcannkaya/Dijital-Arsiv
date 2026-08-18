"""ADR-015 — izole ve idempotent PDF erişim türevi renderer'ı."""
from __future__ import annotations

import hashlib
import os
import secrets
import tempfile
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .planning import (
    MAX_SEGMENT_BYTES,
    PROFILE_VERSION,
    RENDER_DPI,
    ReviewRequired,
    enforce_page_count,
    enforce_page_pixels,
    plan_segments,
)

MAX_BYTES = 2 * 1024 * 1024 * 1024
MAX_WORK_BYTES = 10 * 1024 * 1024 * 1024
CHUNK_BYTES = 8 * 1024 * 1024
IMAGE_DIGEST_PATTERN = r"^sha256:[a-fA-F0-9]{64}$"
SAFE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"

app = FastAPI(title="Sivas Arşiv Belge Render Servisi", version="1.1.0")


class RenderRequest(BaseModel):
    renderId: str = Field(pattern=SAFE_ID_PATTERN)
    profileVersion: str = Field(pattern=r"^access-pdf-v[1-9][0-9]*$")
    expectedRendererImageDigest: str = Field(pattern=IMAGE_DIGEST_PATTERN)
    documentId: str = Field(pattern=SAFE_ID_PATTERN)
    objectKey: str = Field(min_length=1, max_length=1024)
    byteSize: int = Field(gt=0, le=MAX_BYTES)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


def authorize(authorization: str | None = Header(default=None)) -> None:
    token = os.getenv("DOCUMENT_RENDER_SERVICE_TOKEN", "").strip()
    if not token:
        raise HTTPException(status_code=503, detail="DOCUMENT_RENDER_SERVICE_TOKEN tanımlı değil.")
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not secrets.compare_digest(supplied, token):
        raise HTTPException(status_code=401, detail="Yetkisiz.")


def renderer_image_digest(expected: str | None = None) -> str:
    digest = os.getenv("RENDERER_IMAGE_DIGEST", "").strip().lower()
    if len(digest) != 71 or not digest.startswith("sha256:"):
        raise HTTPException(status_code=503, detail="RENDERER_IMAGE_DIGEST yapılandırılmamış.")
    try:
        int(digest[7:], 16)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="RENDERER_IMAGE_DIGEST geçersiz.") from exc
    if expected and not secrets.compare_digest(digest, expected.lower()):
        raise HTTPException(status_code=503, detail="Renderer imaj özeti dağıtım sözleşmesiyle uyuşmuyor.")
    return digest


def pdfium_version() -> str:
    import pypdfium2

    return str(getattr(pypdfium2, "V_PYPDFIUM2", None) or getattr(pypdfium2, "__version__", "unknown"))


def s3_client():
    """S3 istemcisi TEMBEL kurulur (OCR servisiyle aynı düzen).

    Modül tepesinde `import boto3` durduğu sürece servis, S3 yolu hiç
    kullanılmasa bile boto3 olmadan açılamıyordu: yerel geliştirmede depo
    Miniflare R2 emülasyonudur ve S3 ucu yoktur, yani PDF önizlemesi yalnız
    bu import yüzünden hiç denenemiyordu.
    """
    import boto3

    return boto3.client("s3", endpoint_url=os.getenv("RENDER_S3_ENDPOINT_URL") or None)


def s3_client_error() -> type[BaseException]:
    from botocore.exceptions import ClientError

    return ClientError


def _verified_copy(reference: RenderRequest, body: Any, destination: Path) -> None:
    """Kaynaktan bağımsız ortak güvence: boyut ve SHA-256 yeniden doğrulanır."""
    digest = hashlib.sha256()
    size = 0
    try:
        with destination.open("wb") as output:
            while True:
                chunk = body.read(CHUNK_BYTES)
                if not chunk:
                    break
                size += len(chunk)
                if size > reference.byteSize:
                    raise HTTPException(status_code=422, detail="Nesne boyut sınırını aşıyor.")
                digest.update(chunk)
                output.write(chunk)
    finally:
        body.close()
    if size != reference.byteSize or digest.hexdigest() != reference.sha256.lower():
        raise HTTPException(status_code=422, detail="Nesne SHA-256 kanıtı uyuşmuyor.")


def download_original(reference: RenderRequest, destination: Path) -> None:
    if not reference.objectKey.startswith("originals/") or ".." in reference.objectKey.split("/"):
        raise HTTPException(status_code=400, detail="Geçersiz asıl nesne anahtarı.")
    bucket = os.getenv("RENDER_ORIGINAL_BUCKET", "").strip()
    if not bucket:
        raise HTTPException(status_code=503, detail="RENDER_ORIGINAL_BUCKET tanımlı değil.")
    response = s3_client().get_object(Bucket=bucket, Key=reference.objectKey)
    if int(response.get("ContentLength", -1)) != reference.byteSize:
        raise HTTPException(status_code=422, detail="Nesne boyutu yetkili kayıtla uyuşmuyor.")
    _verified_copy(reference, response["Body"], destination)


def render_pages(source: Path, workdir: Path) -> list[Path]:
    """Her sayfayı raster görüntüden tek sayfalık ara PDF'ye çevirir."""
    import pypdfium2 as pdfium

    try:
        document = pdfium.PdfDocument(str(source))
    except Exception as exc:
        raise ReviewRequired(f"PDF açılamadı: {type(exc).__name__}") from exc
    try:
        enforce_page_count(len(document))
        pages: list[Path] = []
        work_bytes = source.stat().st_size
        for index in range(len(document)):
            page = document[index]
            bitmap = None
            raw_image = None
            image = None
            try:
                width, height = enforce_page_pixels(page.get_width(), page.get_height())
                bitmap = page.render(scale=RENDER_DPI / 72)
                raw_image = bitmap.to_pil()
                image = raw_image.convert("RGB")
                if image.size != (width, height):
                    resized = image.resize((width, height))
                    image.close()
                    image = resized
                page_pdf = workdir / f"page-{index + 1:05d}.pdf"
                image.save(page_pdf, "PDF", resolution=RENDER_DPI)
                work_bytes += page_pdf.stat().st_size
                if work_bytes > MAX_WORK_BYTES:
                    raise ReviewRequired("Renderer geçici çalışma alanı güvenlik sınırını aşıyor")
                pages.append(page_pdf)
            except ReviewRequired:
                raise
            except Exception as exc:
                raise ReviewRequired(f"Sayfa {index + 1} güvenle rasterize edilemedi: {type(exc).__name__}") from exc
            finally:
                if image is not None:
                    image.close()
                if raw_image is not None:
                    raw_image.close()
                if bitmap is not None:
                    bitmap.close()
                page.close()
        return pages
    finally:
        document.close()


def assemble_segment(page_files: list[Path], destination: Path, profile_version: str) -> None:
    import pikepdf

    try:
        with pikepdf.new() as target:
            for page_file in page_files:
                with pikepdf.open(page_file) as source_pdf:
                    target.pages.extend(source_pdf.pages)
            with target.open_metadata(set_pikepdf_as_editor=False) as metadata:
                metadata["xmp:CreatorTool"] = f"sivas-arsiv-render {profile_version}"
            target.save(destination, linearize=True)
    except Exception as exc:
        raise ReviewRequired(f"Erişim bölümü güvenle oluşturulamadı: {type(exc).__name__}") from exc


def _existing_segment(client: Any, bucket: str, key: str, document_id: str,
                      render_id: str, profile_version: str) -> dict[str, Any]:
    head = client.head_object(Bucket=bucket, Key=key)
    metadata = {str(k).lower(): str(v) for k, v in head.get("Metadata", {}).items()}
    digest = metadata.get("sha256", "").lower()
    if (
        head.get("ContentType") != "application/pdf"
        or not digest or len(digest) != 64
        or metadata.get("documentid") != document_id
        or metadata.get("generationid") != render_id
        or metadata.get("profileversion") != profile_version
        or metadata.get("objectclass") != "access"
    ):
        raise HTTPException(status_code=409, detail="Var olan türev anahtarı üretim kanıtıyla uyuşmuyor.")
    return {"key": key, "byteSize": int(head["ContentLength"]), "sha256": digest}


def upload_segment(reference: RenderRequest, part: int, source: Path) -> dict[str, Any]:
    bucket = os.getenv("RENDER_DERIVATIVE_BUCKET", "").strip()
    if not bucket:
        raise HTTPException(status_code=503, detail="RENDER_DERIVATIVE_BUCKET tanımlı değil.")
    key = f"derivatives/{reference.documentId}/access/{reference.renderId}/part-{part:04d}.pdf"
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as stream:
        while True:
            chunk = stream.read(CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    if size < 1 or size > MAX_SEGMENT_BYTES:
        raise ReviewRequired(f"Bölüm {part} boyut sınırını karşılamıyor")
    client = s3_client()
    try:
        with source.open("rb") as stream:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=stream,
                ContentType="application/pdf",
                IfNoneMatch="*",
                Metadata={
                    "sha256": digest.hexdigest(),
                    "documentId": reference.documentId,
                    "generationId": reference.renderId,
                    "profileVersion": reference.profileVersion,
                    "objectClass": "access",
                },
            )
    except s3_client_error() as exc:
        status = int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0))
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if status == 412 or code in {"PreconditionFailed", "ConditionalRequestConflict"}:
            # Önceki deneme yanıtını kaybetmiş olabilir. Baytlar Worker tarafından
            # yeniden tam SHA ile doğrulanacağından başlık kanıtıyla güvenle devam edilir.
            return _existing_segment(
                client, bucket, key, reference.documentId,
                reference.renderId, reference.profileVersion,
            )
        raise
    return {"key": key, "byteSize": size, "sha256": digest.hexdigest()}


@app.get("/health")
def health() -> dict[str, Any]:
    configured = bool(
        os.getenv("RENDER_ORIGINAL_BUCKET", "").strip()
        and os.getenv("RENDER_DERIVATIVE_BUCKET", "").strip()
        and os.getenv("DOCUMENT_RENDER_SERVICE_TOKEN", "").strip()
    )
    if not configured:
        raise HTTPException(status_code=503, detail="Renderer depolama veya kimlik ayarı eksik.")
    return {
        "status": "ok",
        "renderer": "pdfium",
        "rendererVersion": pdfium_version(),
        "rendererImageDigest": renderer_image_digest(),
        "profileVersion": PROFILE_VERSION,
        "dpi": RENDER_DPI,
    }


@app.post("/v1/render", dependencies=[Depends(authorize)])
def render(reference: RenderRequest) -> dict[str, Any]:
    image_digest = renderer_image_digest(reference.expectedRendererImageDigest)
    try:
        with tempfile.TemporaryDirectory(prefix="archive-render-") as directory:
            workdir = Path(directory)
            source = workdir / "original.pdf"
            download_original(reference, source)
            pages = render_pages(source, workdir)
            ranges = plan_segments([page.stat().st_size for page in pages])
            segments: list[dict[str, Any]] = []
            for part, (start, end) in enumerate(ranges, start=1):
                segment_pdf = workdir / f"segment-{part:04d}.pdf"
                assemble_segment(pages[start - 1:end], segment_pdf, reference.profileVersion)
                uploaded = upload_segment(reference, part, segment_pdf)
                segments.append({
                    "objectKey": uploaded["key"],
                    "pageStart": start,
                    "pageEnd": end,
                    "byteSize": uploaded["byteSize"],
                    "sha256": uploaded["sha256"],
                })
                segment_pdf.unlink(missing_ok=True)
                for page_file in pages[start - 1:end]:
                    page_file.unlink(missing_ok=True)
            return {
                "renderId": reference.renderId,
                "renderer": "pdfium",
                "rendererVersion": pdfium_version(),
                "rendererImageDigest": image_digest,
                "profileVersion": reference.profileVersion,
                "pageCount": len(pages),
                "segments": segments,
            }
    except ReviewRequired as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "REVIEW_REQUIRED", "message": exc.reason},
        ) from exc
