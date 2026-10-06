"""image bytes -> ExtractResponse. A pure function of its inputs: no database, no object storage."""

from __future__ import annotations

import time
from collections.abc import Callable

import cv2

from app.config import Settings
from app.schemas import (
    BBox,
    ExtractedField,
    ExtractedFields,
    ExtractionDocumentType,
    ExtractResponse,
    ModelVersions,
    Quality,
    Resolution,
    Timings,
)
from app.vision.decode import decode_image
from app.vision.ocr import MODEL_DESCRIPTION, Line, OcrEngine
from app.vision.parsers.aadhaar_back import parse_aadhaar_back
from app.vision.parsers.aadhaar_front import parse_aadhaar_front
from app.vision.parsers.common import ParseResult
from app.vision.parsers.pan import parse_pan
from app.vision.preprocess import preprocess
from app.vision.quality import measure_quality

PARSERS: dict[str, Callable[[list[Line]], ParseResult]] = {
    "PAN": parse_pan,
    "AADHAAR_FRONT": parse_aadhaar_front,
    "AADHAAR_BACK": parse_aadhaar_back,
}
MIN_TEXT_CHARS = 5


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 1)


def _versions() -> ModelVersions:
    import paddleocr

    return ModelVersions(
        ocr=f"paddleocr-{paddleocr.__version__}",
        ocr_models=MODEL_DESCRIPTION,
        preprocessor=f"opencv-{cv2.__version__}",
    )


def _bbox(box: tuple[int, int, int, int], width: int, height: int) -> BBox:
    x0, y0, x1, y1 = box
    clamp = lambda v: round(min(max(v, 0.0), 1.0), 4)  # noqa: E731
    return BBox(x=clamp(x0 / width), y=clamp(y0 / height), w=clamp((x1 - x0) / width), h=clamp((y1 - y0) / height))


def _raw_text(lines: list[Line]) -> str:
    return "\n".join(line.text for line in lines)


def extract(
    *,
    document_id: str,
    document_type: ExtractionDocumentType,
    data: bytes,
    engine: OcrEngine,
    settings: Settings,
    fetch_ms: float = 0.0,
) -> ExtractResponse:
    started = time.perf_counter()
    timings = {"preprocess": 0.0, "ocr": 0.0, "parse": 0.0}

    def respond(status, quality: Quality, fields: ExtractedFields, raw_text: str) -> ExtractResponse:  # noqa: ANN001
        return ExtractResponse(
            document_id=document_id,
            document_type=document_type,
            status=status,
            quality=quality,
            fields=fields,
            raw_text=raw_text,
            model_versions=_versions(),
            timings=Timings(
                fetch_ms=fetch_ms,
                preprocess_ms=timings["preprocess"],
                ocr_ms=timings["ocr"],
                parse_ms=timings["parse"],
                total_ms=round(fetch_ms + _ms(started), 1),
            ),
        )

    t = time.perf_counter()
    image = decode_image(data, max_pixels=settings.max_pixels, pdf_dpi=settings.pdf_render_dpi)
    measured = measure_quality(image, min_sharpness=settings.min_sharpness, min_side_px=settings.min_side_px)
    height, width = image.shape[:2]

    def quality_model(angle: float = 0.0) -> Quality:
        return Quality(
            sharpness=measured.sharpness,
            brightness=measured.brightness,
            resolution=Resolution(w=width, h=height),
            deskew_angle=angle,
            warnings=list(measured.warnings),
        )

    # Gate 1: too blurry or too small. Don't spend OCR time (or trust a guess) on it.
    if measured.blocking:
        timings["preprocess"] = _ms(t)
        return respond("low_quality", quality_model(), ExtractedFields(), "")

    prepared = preprocess(image)
    timings["preprocess"] = _ms(t)

    t = time.perf_counter()
    with_hindi = document_type == "AADHAAR_BACK"
    lines = engine.read(prepared.image, with_hindi=with_hindi)
    if sum(len(line.text) for line in lines) < MIN_TEXT_CHARS:
        # Nothing read. The thresholded image sometimes helps on faint prints; try it once.
        lines = engine.read(cv2.cvtColor(prepared.binary, cv2.COLOR_GRAY2BGR), with_hindi=with_hindi)
    timings["ocr"] = _ms(t)

    quality = quality_model(prepared.angle)
    if sum(len(line.text) for line in lines) < MIN_TEXT_CHARS:
        return respond("parse_failed", quality, ExtractedFields(), "")

    t = time.perf_counter()
    result = PARSERS[document_type](lines)
    timings["parse"] = _ms(t)

    fields = ExtractedFields(
        **{
            key: ExtractedField(
                value=f.value,
                confidence=round(min(max(f.confidence, 0.0), 1.0), 4),
                bbox=_bbox(f.box, width, height),
            )
            for key, f in result.fields.items()
        }
    )
    quality.warnings.extend(result.warnings)
    return respond(result.status, quality, fields, _raw_text(lines))


__all__ = ["extract", "PARSERS"]
