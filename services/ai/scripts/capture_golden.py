"""Runs the real OCR on the synthetic sample documents and stores the raw lines as golden test data.

    uv run python scripts/capture_golden.py

The fast parser tests replay these lines, so CI doesn't need the OCR models. Re-run this (and review
the diff) whenever the OCR models or the preprocessing change.
"""

import json
from pathlib import Path

from app.config import get_settings
from app.vision.decode import decode_image
from app.vision.ocr import PaddleOcrEngine
from app.vision.preprocess import preprocess

ROOT = Path(__file__).resolve().parents[3]
SAMPLES = ROOT / "scripts" / "sample-docs"
GOLDEN = Path(__file__).resolve().parents[1] / "tests" / "golden"

engine = PaddleOcrEngine()
settings = get_settings()
GOLDEN.mkdir(exist_ok=True)
for name in ("pan", "aadhaar-front", "aadhaar-back"):
    image = decode_image((SAMPLES / f"{name}.png").read_bytes(), max_pixels=settings.max_pixels)
    lines = engine.read(preprocess(image).image, with_hindi=name == "aadhaar-back")
    out = [{"text": ln.text, "box": list(ln.box), "confidence": ln.confidence} for ln in lines]
    (GOLDEN / f"{name}.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(f"== {name}: {len(out)} lines")
    for ln in out:
        print(f"   {ln['confidence']:.2f} {ln['box']} {ln['text']!r}")
