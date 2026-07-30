from __future__ import annotations

import subprocess
import warnings
from pathlib import Path

MIME_EXTENSIONS = {
    "application/pdf": {".pdf"},
    "image/jpeg": {".jpg", ".jpeg"},
    "image/png": {".png"},
    "image/tiff": {".tif", ".tiff"},
}


def detect_media_type(header: bytes) -> str | None:
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    # ISO 32000 permits the PDF header within the first 1024 bytes.
    pdf_at = header[:1024].find(b"%PDF-")
    if pdf_at >= 0 and header[:pdf_at].strip(b" \t\r\n") == b"":
        return "application/pdf"
    return None


def type_validation(declared: str, extension: str, detected: str | None) -> str:
    if detected not in MIME_EXTENSIONS:
        return "UNSUPPORTED"
    if declared != detected or extension.lower() not in MIME_EXTENSIONS[detected]:
        return "MISMATCH"
    return "MATCH"


def validate_parser(path: Path, media_type: str) -> tuple[str, str, str]:
    if media_type == "application/pdf":
        completed = subprocess.run(
            ["qpdf", "--check", "--no-warn", str(path)],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        return ("qpdf", _tool_version(["qpdf", "--version"]), "VALID" if completed.returncode == 0 else "INVALID")
    if media_type in {"image/jpeg", "image/png", "image/tiff"}:
        from PIL import Image, UnidentifiedImageError

        Image.MAX_IMAGE_PIXELS = 250_000_000
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    expected = {"image/jpeg": "JPEG", "image/png": "PNG", "image/tiff": "TIFF"}[media_type]
                    if image.format != expected:
                        return ("pillow", Image.__version__, "INVALID")
                    image.verify()
            return ("pillow", Image.__version__, "VALID")
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombWarning):
            return ("pillow", Image.__version__, "INVALID")
    return ("unsupported", "unknown", "ERROR")


def _tool_version(command: list[str]) -> str:
    completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    line = (completed.stdout or completed.stderr).splitlines()
    return line[0][:120] if line else "unknown"


def classify_clamav_exit(return_code: int) -> str:
    if return_code == 0:
        return "CLEAN"
    if return_code == 1:
        return "MALICIOUS"
    return "ERROR"

