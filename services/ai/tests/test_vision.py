"""Image-level tests that don't need the OCR models: decode, quality gates, deskew."""

from io import BytesIO

import cv2
import numpy as np
import pytest
from conftest import sample_bytes
from PIL import Image, ImageFilter

from app.vision.decode import DecodeError, decode_image
from app.vision.preprocess import estimate_skew, preprocess
from app.vision.quality import measure_quality

MAX = 40_000_000


def pil(name: str = "pan") -> Image.Image:
    return Image.open(BytesIO(sample_bytes(name))).convert("RGB")


def png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def rotate(image: np.ndarray, degrees: float) -> np.ndarray:
    h, w = image.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), degrees, 1.0)
    return cv2.warpAffine(image, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


class TestQuality:
    def test_sample_passes_the_gates(self):
        q = measure_quality(decode_image(sample_bytes("pan"), max_pixels=MAX), min_sharpness=50, min_side_px=400)
        assert (q.width, q.height) == (1400, 880)
        assert q.sharpness > 50 and not q.blocking and q.warnings == []

    def test_blur_makes_it_low_sharpness(self):
        sharp = measure_quality(decode_image(sample_bytes("pan"), max_pixels=MAX), min_sharpness=50, min_side_px=400)
        blurred = png(pil().filter(ImageFilter.GaussianBlur(9)))
        q = measure_quality(decode_image(blurred, max_pixels=MAX), min_sharpness=50, min_side_px=400)
        assert q.sharpness < sharp.sharpness
        assert q.blocking and q.warnings[0].startswith("LOW_SHARPNESS (")

    def test_small_images_are_low_resolution(self):
        small = png(pil().resize((380, 240), Image.LANCZOS))
        q = measure_quality(decode_image(small, max_pixels=MAX), min_sharpness=0, min_side_px=400)
        assert q.blocking and any(w.startswith("LOW_RESOLUTION (min side 240 < 400)") for w in q.warnings)

    def test_sharpness_does_not_depend_on_the_resolution(self):
        big = measure_quality(decode_image(sample_bytes("pan"), max_pixels=MAX), min_sharpness=50, min_side_px=400)
        half = png(pil().resize((700, 440), Image.LANCZOS))
        small = measure_quality(decode_image(half, max_pixels=MAX), min_sharpness=50, min_side_px=400)
        assert small.sharpness > 50 and big.sharpness > 50

    def test_dark_and_bright_images_warn_but_do_not_block(self):
        dark = png(Image.new("RGB", (800, 600), (10, 10, 10)))
        q = measure_quality(decode_image(dark, max_pixels=MAX), min_sharpness=0, min_side_px=400)
        assert any(w.startswith("TOO_DARK") for w in q.warnings) and not q.blocking


class TestDecode:
    def test_applies_exif_orientation(self):
        img = pil()
        exif = Image.Exif()
        exif[0x0112] = 6  # "rotate 90 degrees clockwise to display"
        buf = BytesIO()
        img.save(buf, format="JPEG", exif=exif)
        out = decode_image(buf.getvalue(), max_pixels=MAX)
        assert out.shape[:2] == (1400, 880)  # width and height swapped

    def test_renders_the_first_page_of_a_pdf(self):
        buf = BytesIO()
        pil().save(buf, format="PDF")
        out = decode_image(buf.getvalue(), max_pixels=MAX, pdf_dpi=100)
        assert out.shape[0] > 400 and out.shape[1] > 400

    @pytest.mark.parametrize("data", [b"", b"not an image", b"%PDF-1.4 truncated"])
    def test_garbage_is_a_decode_error(self, data):
        with pytest.raises(DecodeError):
            decode_image(data, max_pixels=MAX)

    def test_rejects_oversized_images(self):
        with pytest.raises(DecodeError, match="too large"):
            decode_image(sample_bytes("pan"), max_pixels=1000)


class TestDeskew:
    def test_straight_image_is_left_alone(self):
        image = decode_image(sample_bytes("pan"), max_pixels=MAX)
        assert abs(estimate_skew(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY))) < 0.6
        assert preprocess(image).angle == 0.0

    @pytest.mark.parametrize("degrees", [4.0, -4.0, 8.0, -8.0])
    def test_detects_and_corrects_a_tilt(self, degrees):
        tilted = rotate(decode_image(sample_bytes("pan"), max_pixels=MAX), degrees)
        angle = estimate_skew(cv2.cvtColor(tilted, cv2.COLOR_BGR2GRAY))
        assert abs(abs(angle) - abs(degrees)) < 1.5, angle
        fixed = preprocess(tilted)
        residual = estimate_skew(fixed.gray)
        assert abs(residual) < 1.5
        assert fixed.image.shape == tilted.shape  # same canvas, so normalised bboxes stay valid

    def test_returns_all_three_variants(self):
        p = preprocess(decode_image(sample_bytes("aadhaar-front"), max_pixels=MAX))
        assert p.image.ndim == 3 and p.gray.ndim == 2 and set(np.unique(p.binary)) <= {0, 255}
