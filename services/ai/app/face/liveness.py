"""The motion check: three frames shot 300 ms apart, and whether anything moved.

THIS IS NOT PRODUCTION LIVENESS. It notices a photograph or a screen held still in front of the camera, because the three
frames are then almost the same picture. It does not notice a replayed video, a mask, a deepfake or someone holding the photo
and moving it. It is called a motion check here, in the API, in the audit log and on screen, and must stay that.
"""

from __future__ import annotations

import cv2
import numpy as np

from app.config import Settings
from app.face.detect import Face, detect_faces, iou
from app.face.models import FaceModels
from app.vision.quality import measure_quality

MODEL_VERSION = "motion-check-1:yunet-2023mar"

_SSIM_SIZE = 128
_C1, _C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    """Structural similarity of two equally sized grey images (Wang et al. 2004: 11x11 Gaussian window, sigma 1.5)."""
    a = a.astype(np.float64)
    b = b.astype(np.float64)

    def blur(x: np.ndarray) -> np.ndarray:
        return cv2.GaussianBlur(x, (11, 11), 1.5)

    mu_a, mu_b = blur(a), blur(b)
    var_a = blur(a * a) - mu_a * mu_a
    var_b = blur(b * b) - mu_b * mu_b
    cov = blur(a * b) - mu_a * mu_b
    score = ((2 * mu_a * mu_b + _C1) * (2 * cov + _C2)) / ((mu_a**2 + mu_b**2 + _C1) * (var_a + var_b + _C2))
    return float(score.mean())


def _crop(image: np.ndarray, box: tuple[float, float, float, float]) -> np.ndarray:
    x, y, w, h = box
    height, width = image.shape[:2]
    x0, y0 = max(int(x), 0), max(int(y), 0)
    x1, y1 = min(int(x + w), width), min(int(y + h), height)
    gray = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    return cv2.resize(gray, (_SSIM_SIZE, _SSIM_SIZE), interpolation=cv2.INTER_AREA)


def _is_central(face: Face, shape: tuple[int, ...], margin: float) -> bool:
    height, width = shape[:2]
    cx, cy = face.center
    return margin * width <= cx <= (1 - margin) * width and margin * height <= cy <= (1 - margin) * height


def run_motion_check(
    models: FaceModels, frames: list[np.ndarray], best: np.ndarray, settings: Settings
) -> dict:
    """Returns the fields of the `MotionCheckResponse` contract (without the capture id)."""
    metrics: dict = {
        "ssimPairs": [],
        "meanSsim": None,
        "boxIouPairs": [],
        "facesPerFrame": [],
        "sharpness": None,
        "brightness": None,
    }

    def outcome(result: str, reason: str | None) -> dict:
        return {
            "method": "MOTION_CHECK",
            "result": result,
            "failureReason": reason,
            "metrics": metrics,
            "modelVersion": MODEL_VERSION,
        }

    found = [detect_faces(models, frame) for frame in frames]
    metrics["facesPerFrame"] = [len(f) for f in found]
    if any(len(f) != 1 for f in found):
        return outcome("FAILED", "NO_FACE_IN_FRAME")
    faces = [f[0] for f in found]
    if not all(_is_central(f, fr.shape, settings.liveness_central_margin) for f, fr in zip(faces, frames, strict=True)):
        return outcome("FAILED", "FACE_MOVED_OUT")

    boxes = [f.box() for f in faces]
    metrics["boxIouPairs"] = [round(iou(a, b), 4) for a, b in zip(boxes, boxes[1:], strict=False)]
    if any(v < settings.liveness_min_box_iou for v in metrics["boxIouPairs"]):
        return outcome("FAILED", "FACE_MOVED_OUT")

    # SSIM is measured inside the face, on the region the two boxes cover together: the background is the same in a real
    # video and in a photo of a photo, so it says nothing.
    pairs = []
    for (fa, ba), (fb, bb) in zip(zip(frames, boxes), zip(frames[1:], boxes[1:]), strict=False):
        x = min(ba[0], bb[0])
        y = min(ba[1], bb[1])
        w = max(ba[0] + ba[2], bb[0] + bb[2]) - x
        h = max(ba[1] + ba[3], bb[1] + bb[3]) - y
        pairs.append(ssim(_crop(fa, (x, y, w, h)), _crop(fb, (x, y, w, h))))
    metrics["ssimPairs"] = [round(v, 4) for v in pairs]
    metrics["meanSsim"] = round(float(np.mean(pairs)), 4)
    if metrics["meanSsim"] > settings.liveness_max_mean_ssim:
        return outcome("FAILED", "FRAMES_TOO_SIMILAR")

    quality = measure_quality(best, min_sharpness=settings.liveness_min_sharpness, min_side_px=0)
    metrics["sharpness"] = quality.sharpness
    metrics["brightness"] = quality.brightness
    if (
        quality.sharpness < settings.liveness_min_sharpness
        or quality.brightness < settings.liveness_min_brightness
        or quality.brightness > settings.liveness_max_brightness
    ):
        return outcome("INCONCLUSIVE", "QUALITY_TOO_LOW")
    return outcome("PASSED", None)
