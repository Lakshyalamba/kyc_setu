"""Run at image build time so the OCR weights are baked into the image and never fetched on first request."""

import numpy as np

from app.config import get_settings
from app.vision.ocr import PaddleOcrEngine

_s = get_settings()
engine = PaddleOcrEngine(cpu_threads=_s.ocr_cpu_threads, enable_mkldnn=_s.ocr_enable_mkldnn)  # downloads detector + English + Devanagari recognisers
engine.read(np.full((64, 256, 3), 255, dtype=np.uint8), with_hindi=True)  # proves they actually run
print("OCR models ready:", engine.status)
