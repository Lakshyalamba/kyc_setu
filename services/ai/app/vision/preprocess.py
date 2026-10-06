from dataclasses import dataclass

import cv2
import numpy as np

# Photos are rarely tilted more than this; anything beyond is more likely a bad estimate than a skew.
_MAX_DESKEW_DEGREES = 15.0
_MIN_DESKEW_DEGREES = 0.4


@dataclass
class Preprocessed:
    image: np.ndarray  # deskewed BGR; this is what OCR reads and what bboxes refer to
    gray: np.ndarray  # deskewed grayscale
    binary: np.ndarray  # adaptive threshold; fallback input if the first OCR pass reads nothing
    angle: float  # degrees the image was rotated by (0 if left alone)


def _line_angle(contour: np.ndarray) -> float:
    """Direction (degrees, folded into (-45, 45]) of the long side of the contour's min-area rectangle."""
    corners = cv2.boxPoints(cv2.minAreaRect(contour))
    edges = [corners[(i + 1) % 4] - corners[i] for i in range(4)]
    dx, dy = max(edges, key=lambda e: float(np.hypot(*e)))
    angle = float(np.degrees(np.arctan2(dy, dx)))
    angle = (angle + 90) % 180 - 90  # (-90, 90]
    if angle > 45:
        angle -= 180 if angle > 90 else 90
    elif angle <= -45:
        angle += 90
    return angle


def estimate_skew(gray: np.ndarray) -> float:
    """Skew in degrees: the median tilt of the text lines (min-area rectangle of each line contour).

    Positive means the text runs downhill to the right (a clockwise tilt). Using each line separately,
    rather than one rectangle around all the ink, keeps the header bars and photo frame from biasing it.
    """
    scale = 1000 / gray.shape[1] if gray.shape[1] > 1000 else 1.0
    small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale != 1.0 else gray
    ink = cv2.adaptiveThreshold(
        cv2.GaussianBlur(small, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15
    )
    # Smear letters sideways so each text line becomes one elongated blob.
    blobs = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_RECT, (31, 3)))
    contours, _ = cv2.findContours(blobs, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = 0.0008 * small.shape[0] * small.shape[1]
    angles: list[float] = []
    for contour in contours:
        if cv2.contourArea(contour) < min_area:
            continue
        (_, _), (w, h), _ = cv2.minAreaRect(contour)
        if max(w, h) < 3.5 * max(min(w, h), 1):  # only clearly line-shaped blobs say anything about tilt
            continue
        angles.append(_line_angle(contour))
    return float(np.median(angles)) if len(angles) >= 3 else 0.0


def preprocess(image: np.ndarray) -> Preprocessed:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    angle = estimate_skew(gray)
    if _MIN_DESKEW_DEGREES <= abs(angle) <= _MAX_DESKEW_DEGREES:
        h, w = gray.shape
        matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        flags, border = cv2.INTER_CUBIC, cv2.BORDER_REPLICATE
        image = cv2.warpAffine(image, matrix, (w, h), flags=flags, borderMode=border)
        gray = cv2.warpAffine(gray, matrix, (w, h), flags=flags, borderMode=border)
    else:
        angle = 0.0
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15
    )
    return Preprocessed(image=image, gray=gray, binary=binary, angle=round(angle, 2))
