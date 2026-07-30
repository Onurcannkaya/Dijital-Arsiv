from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .file_validation import classify_clamav_exit, detect_media_type, type_validation, validate_parser

MAX_BYTES = 2 * 1024 * 1024 * 1024
CHUNK_BYTES = 8 * 1024 * 1024
SIGNATURE_MAX_AGE_SECONDS = 24 * 60 * 60

app = FastAPI(title="Sivas Arşiv İçerik Tarama Servisi", version="1.0.0")


class ScanRequest(BaseModel):
    sessionId: str = Field(min_length=1, max_length=128)
    objectKey: str = Field(min_length=1, max_length=1024)
    declaredMediaType: str = Field(min_length=1, max_length=120)
    fileExtension: str = Field(max_length=12)
    byteSize: int = Field(gt=0, le=MAX_BYTES)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


def authorize(authorization: str | None = Header(default=None)) -> None:
    token = os.getenv("CONTENT_SCAN_SERVICE_TOKEN", "").strip()
    if not token:
        raise HTTPException(status_code=503, detail="CONTENT_SCAN_SERVICE_TOKEN tanımlı değil.")
    if authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="Yetkisiz.")


def signature_state() -> tuple[str, bool]:
    candidates = list(Path("/var/lib/clamav").glob("*.cvd")) + list(Path("/var/lib/clamav").glob("*.cld"))
    if not candidates:
        return ("missing", False)
    newest = max(candidates, key=lambda path: path.stat().st_mtime)
    age = datetime.now(timezone.utc).timestamp() - newest.stat().st_mtime
    return (f"{newest.name}:{int(newest.stat().st_mtime)}", age <= SIGNATURE_MAX_AGE_SECONDS)


def clamav_version() -> str:
    completed = subprocess.run(["clamscan", "--version"], capture_output=True, text=True, timeout=10, check=False)
    lines = (completed.stdout or completed.stderr).strip().splitlines()
    return lines[0][:120] if lines else "unknown"


def download(reference: ScanRequest, destination: Path) -> None:
    bucket = os.getenv("CONTENT_SCAN_QUARANTINE_BUCKET", "").strip()
    if not bucket:
        raise HTTPException(status_code=503, detail="Karantina kovası yapılandırılmamış.")
    if not reference.objectKey.startswith("quarantine/") or ".." in reference.objectKey:
        raise HTTPException(status_code=400, detail="Geçersiz karantina nesne anahtarı.")
    client = boto3.client("s3", endpoint_url=os.getenv("CONTENT_SCAN_S3_ENDPOINT_URL") or None)
    response = client.get_object(Bucket=bucket, Key=reference.objectKey)
    declared_length = int(response.get("ContentLength", -1))
    if declared_length != reference.byteSize:
        raise HTTPException(status_code=422, detail="Nesne boyutu yetkili kayıtla uyuşmuyor.")
    digest = hashlib.sha256()
    size = 0
    with destination.open("wb") as output:
        body = response["Body"]
        while True:
            chunk = body.read(CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            if size > reference.byteSize or size > MAX_BYTES:
                raise HTTPException(status_code=422, detail="Nesne boyut sınırını aşıyor.")
            digest.update(chunk)
            output.write(chunk)
    if size != reference.byteSize or digest.hexdigest() != reference.sha256.lower():
        raise HTTPException(status_code=422, detail="Nesne SHA-256 veya boyut kanıtı uyuşmuyor.")


@app.get("/health")
def health() -> dict[str, Any]:
    signature_version, fresh = signature_state()
    return {
        "status": "ok" if fresh else "degraded",
        "scannerReady": fresh,
        "engine": "clamav",
        "engineVersion": clamav_version(),
        "signatureVersion": signature_version,
    }


@app.post("/v1/scan", dependencies=[Depends(authorize)])
def scan(reference: ScanRequest) -> dict[str, Any]:
    signature_version, fresh = signature_state()
    if not fresh:
        raise HTTPException(status_code=503, detail="ClamAV imza veritabanı eksik veya 24 saatten eski.")
    with tempfile.TemporaryDirectory(prefix="archive-scan-") as directory:
        source = Path(directory) / "payload"
        download(reference, source)
        with source.open("rb") as stream:
            detected = detect_media_type(stream.read(4096))
        detected_value = detected or "application/octet-stream"
        type_result = type_validation(reference.declaredMediaType, reference.fileExtension, detected)
        parser_name, parser_version, parser_result = validate_parser(source, detected_value)
        completed = subprocess.run(
            ["clamscan", "--infected", "--no-summary", str(source)],
            capture_output=True,
            text=True,
            timeout=10 * 60,
            check=False,
        )
        scanner_result = classify_clamav_exit(completed.returncode)
        if scanner_result == "ERROR":
            raise HTTPException(status_code=503, detail="ClamAV bütün nesneyi tarayamadı.")
        return {
            "sha256": reference.sha256.lower(),
            "byteSize": reference.byteSize,
            "detectedMediaType": detected_value,
            "typeValidationResult": type_result,
            "parserName": parser_name,
            "parserVersion": parser_version,
            "parserResult": parser_result,
            "scannerEngine": "clamav",
            "scannerVersion": clamav_version(),
            "scannerSignatureVersion": signature_version,
            "scannerResult": scanner_result,
        }

