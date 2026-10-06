"""End-to-end through the real OCR models (slow). Run with `pytest -m ocr`, skip with `-m 'not ocr'`."""

import re
from io import BytesIO

import cv2
import numpy as np
import pytest
from conftest import sample_bytes
from PIL import Image, ImageFilter

from app.config import Settings
from app.pipeline import extract

pytestmark = pytest.mark.ocr
DOC = "3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13"


def run(engine, doc_type: str, data: bytes):  # noqa: ANN001
    return extract(document_id=DOC, document_type=doc_type, data=data, engine=engine, settings=Settings(load_models=False))


def encode(img: Image.Image, fmt: str = "PNG", **kw) -> bytes:  # noqa: ANN003
    buf = BytesIO()
    img.save(buf, format=fmt, **kw)
    return buf.getvalue()


def sample(name: str) -> Image.Image:
    return Image.open(BytesIO(sample_bytes(name))).convert("RGB")


def v(result, key: str) -> str:  # noqa: ANN001
    """Value of a field given its contract (camelCase) name."""
    return getattr(result.fields, re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), key)).value


class TestHappyPath:
    def test_pan(self, real_engine, expected):
        r = run(real_engine, "PAN", sample_bytes("pan"))
        assert r.status == "ok"
        for key, want in expected["pan"].items():
            assert v(r, key) == want
        assert r.fields.name.confidence > 0.9
        assert r.quality.warnings == [] and r.timings.ocr_ms > 0 and r.timings.total_ms >= r.timings.ocr_ms
        assert "ABCDE1234F" in r.raw_text

    def test_aadhaar_front_masks_the_number_but_the_raw_text_keeps_it(self, real_engine, expected):
        r = run(real_engine, "AADHAAR_FRONT", sample_bytes("aadhaar-front"))
        assert r.status == "ok"
        for key, want in expected["aadhaar-front"].items():
            assert v(r, key) == want
        assert "2341 2341 2346" in r.raw_text  # encrypted by the Node worker; never returned by the API
        assert "234123412346" not in r.fields.model_dump_json()

    def test_aadhaar_back_reads_english_and_hindi(self, real_engine, expected):
        r = run(real_engine, "AADHAAR_BACK", sample_bytes("aadhaar-back"))
        assert r.status == "ok" and v(r, "pincode") == expected["aadhaar-back"]["pincode"]
        for part in expected["aadhaar-back"]["addressContains"]:
            assert part in v(r, "address")
        assert any("ऀ" <= ch <= "ॿ" for ch in r.raw_text)  # the Hindi address made it into the raw text

    def test_bboxes_are_normalised_and_point_at_the_value(self, real_engine):
        r = run(real_engine, "PAN", sample_bytes("pan"))
        for f in r.fields.model_dump().values():
            if f:
                b = f["bbox"]
                assert 0 <= b["x"] <= 1 and 0 <= b["y"] <= 1 and b["x"] + b["w"] <= 1.001 and b["y"] + b["h"] <= 1.001
        # The PAN number is the big line near the top-left; the DOB is lower down.
        assert r.fields.pan_number.bbox.y < r.fields.dob.bbox.y


class TestRobustness:
    def test_jpeg_compression(self, real_engine, expected):
        r = run(real_engine, "PAN", encode(sample("pan"), "JPEG", quality=55))
        assert r.status == "ok"
        assert v(r, "panNumber") == expected["pan"]["panNumber"]

    @pytest.mark.parametrize("degrees", [5, -5])
    def test_tilted_photo_is_deskewed(self, real_engine, expected, degrees):
        arr = cv2.cvtColor(np.asarray(sample("pan")), cv2.COLOR_RGB2BGR)
        h, w = arr.shape[:2]
        tilted = cv2.warpAffine(arr, cv2.getRotationMatrix2D((w / 2, h / 2), degrees, 1.0), (w, h), borderMode=cv2.BORDER_REPLICATE)
        data = encode(Image.fromarray(cv2.cvtColor(tilted, cv2.COLOR_BGR2RGB)))
        r = run(real_engine, "PAN", data)
        assert r.status == "ok" and abs(r.quality.deskew_angle) > 1
        assert r.fields.pan_number.value == expected["pan"]["panNumber"]

    def test_sideways_phone_photo_via_exif(self, real_engine, expected):
        exif = Image.Exif()
        exif[0x0112] = 6
        rotated = sample("pan").rotate(90, expand=True)  # stored sideways; EXIF says rotate back
        r = run(real_engine, "PAN", encode(rotated, "JPEG", exif=exif, quality=90))
        assert r.status in {"ok", "parse_failed"}  # orientation sign conventions differ by tag; must not crash
        assert r.quality.resolution.w >= 400


class TestGates:
    def test_blurred_image_is_low_quality_and_skips_ocr(self, real_engine):
        r = run(real_engine, "PAN", encode(sample("pan").filter(ImageFilter.GaussianBlur(9))))
        assert r.status == "low_quality"
        assert r.quality.warnings and r.quality.warnings[0].startswith("LOW_SHARPNESS")
        assert r.timings.ocr_ms == 0 and r.raw_text == "" and r.fields.model_dump(exclude_none=True) == {}

    def test_small_image_is_low_quality(self, real_engine):
        r = run(real_engine, "PAN", encode(sample("pan").resize((380, 240), Image.LANCZOS)))
        assert r.status == "low_quality" and any(w.startswith("LOW_RESOLUTION") for w in r.quality.warnings)

    def test_a_blank_page_is_never_ok(self, real_engine):
        r = run(real_engine, "PAN", encode(Image.new("RGB", (900, 600), (255, 255, 255))))
        assert r.status in {"low_quality", "parse_failed"} and r.fields.model_dump(exclude_none=True) == {}

    def test_sharp_noise_with_no_text_is_parse_failed_or_wrong_document(self, real_engine):
        noise = Image.fromarray(np.random.default_rng(0).integers(0, 255, (700, 900, 3), dtype=np.uint8))
        r = run(real_engine, "PAN", encode(noise))
        assert r.status in {"parse_failed", "wrong_document"}


class TestWrongDocument:
    @pytest.mark.parametrize(("doc_type", "sample_name"), [
        ("AADHAAR_FRONT", "pan"),
        ("AADHAAR_BACK", "pan"),
        ("PAN", "aadhaar-front"),
        ("PAN", "aadhaar-back"),
        ("AADHAAR_BACK", "aadhaar-front"),
    ])  # fmt: skip
    def test_documents_in_the_wrong_slot_are_rejected(self, real_engine, doc_type, sample_name):
        r = run(real_engine, doc_type, sample_bytes(sample_name))
        assert r.status == "wrong_document", (doc_type, sample_name, r.fields)
        assert r.fields.model_dump(exclude_none=True) == {}
