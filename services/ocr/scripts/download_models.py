"""PaddleOCR model varlıklarını konteyner imajına önceden indirir."""

from app.main import engine


if __name__ == "__main__":
    loaded = engine()
    print(f"OCR model cache prepared: {type(loaded).__name__}")
