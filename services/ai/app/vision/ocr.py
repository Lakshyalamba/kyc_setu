"""PaddleOCR wrapper. Models are loaded once, at process start, never per request."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Protocol

import numpy as np

# Explicit model names. (Passing a detection model name makes PaddleOCR ignore `lang`, so the
# recognition models are named too.) The *mobile* detector is deliberate: the server-size one needed
# ~70 s and ~7 GB per image on an 8 GB CPU-only machine, versus ~1.5 s for the mobile one.
DETECTION_MODEL = "PP-OCRv5_mobile_det"
EN_RECOGNITION_MODEL = "en_PP-OCRv5_mobile_rec"
HI_RECOGNITION_MODEL = "devanagari_PP-OCRv3_mobile_rec"
MODEL_DESCRIPTION = f"{DETECTION_MODEL} + {EN_RECOGNITION_MODEL} (+ {HI_RECOGNITION_MODEL} for Devanagari)"


@dataclass(frozen=True)
class Line:
    """One recognised text line. `box` is (x0, y0, x1, y1) in pixels of the image that was read."""

    text: str
    box: tuple[int, int, int, int]
    confidence: float


class OcrEngine(Protocol):
    def read(self, image: np.ndarray, *, with_hindi: bool = False) -> list[Line]: ...

    @property
    def status(self) -> dict[str, str]: ...


def _vertical_overlap(a: Line, b: Line) -> float:
    top, bottom = max(a.box[1], b.box[1]), min(a.box[3], b.box[3])
    shorter = min(a.box[3] - a.box[1], b.box[3] - b.box[1])
    return max(bottom - top, 0) / shorter if shorter > 0 else 0.0


def merge_into_lines(words: list[Line]) -> list[Line]:
    """Joins boxes that sit on the same visual row (e.g. a number split into '2341', '2341', '2346')."""
    rows: list[list[Line]] = []
    for word in sorted(words, key=lambda w: (w.box[1] + w.box[3]) / 2):
        for row in rows:
            if _vertical_overlap(row[0], word) > 0.6:
                row.append(word)
                break
        else:
            rows.append([word])
    merged: list[Line] = []
    for row in rows:
        row.sort(key=lambda w: w.box[0])
        weights = [max(len(w.text), 1) for w in row]
        confidence = sum(w.confidence * n for w, n in zip(row, weights, strict=True)) / sum(weights)
        merged.append(
            Line(
                text=" ".join(w.text for w in row),
                box=(
                    min(w.box[0] for w in row),
                    min(w.box[1] for w in row),
                    max(w.box[2] for w in row),
                    max(w.box[3] for w in row),
                ),
                confidence=round(confidence, 4),
            )
        )
    return sorted(merged, key=lambda line: (line.box[1], line.box[0]))


def _overlap_ratio(a: Line, b: Line) -> float:
    """Intersection area as a fraction of the smaller box."""
    w = min(a.box[2], b.box[2]) - max(a.box[0], b.box[0])
    h = min(a.box[3], b.box[3]) - max(a.box[1], b.box[1])
    if w <= 0 or h <= 0:
        return 0.0
    smaller = min((a.box[2] - a.box[0]) * (a.box[3] - a.box[1]), (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))
    return (w * h) / smaller if smaller > 0 else 0.0


def _has_devanagari(text: str) -> bool:
    return any("ऀ" <= ch <= "ॿ" for ch in text)


class PaddleOcrEngine:
    """English engine always; a Devanagari engine for the Aadhaar back's Hindi text."""

    def __init__(self, *, cpu_threads: int | None = None, enable_mkldnn: bool | None = None) -> None:
        from paddleocr import PaddleOCR  # imported here: it is slow, and tests without OCR skip it

        common = dict(
            use_doc_orientation_classify=False,  # EXIF is handled in decode.py
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_detection_model_name=DETECTION_MODEL,
        )
        if cpu_threads is not None:
            common["cpu_threads"] = cpu_threads
        if enable_mkldnn is not None:
            common["enable_mkldnn"] = enable_mkldnn
        self._en = PaddleOCR(text_recognition_model_name=EN_RECOGNITION_MODEL, **common)
        self._hi = PaddleOCR(text_recognition_model_name=HI_RECOGNITION_MODEL, **common)
        # The Paddle predictor is not thread-safe; OCR is CPU-bound anyway, so serialise it.
        self._lock = threading.Lock()

    @property
    def status(self) -> dict[str, str]:
        return {"detector": "loaded", "en": "loaded", "hi": "loaded"}

    def _run(self, engine, image: np.ndarray) -> list[Line]:  # noqa: ANN001
        with self._lock:
            result = engine.predict(image)[0]
        words: list[Line] = []
        for text, score, box in zip(result["rec_texts"], result["rec_scores"], result["rec_boxes"], strict=True):
            if text.strip():
                x0, y0, x1, y1 = (int(v) for v in box)
                words.append(Line(text.strip(), (x0, y0, x1, y1), float(score)))
        return merge_into_lines(words)

    def read(self, image: np.ndarray, *, with_hindi: bool = False) -> list[Line]:
        lines = self._run(self._en, image)
        if not with_hindi:
            return lines
        # Keep the English reading of Latin text and take the Hindi model's reading of Devanagari text.
        # The English model produces gibberish for Devanagari, so drop any English line that a
        # Devanagari line sits on top of.
        hindi = [line for line in self._run(self._hi, image) if _has_devanagari(line.text)]
        lines = [ln for ln in lines if not any(_overlap_ratio(ln, h) > 0.5 for h in hindi)]
        return sorted([*lines, *hindi], key=lambda line: (line.box[1], line.box[0]))
