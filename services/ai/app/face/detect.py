from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.face.models import FaceModels

# YuNet finds faces best when they are neither tiny nor filling the frame. A face that fills a phone selfie is retried at half size.
_RETRY_SCALE = 0.5


@dataclass(frozen=True)
class Face:
    x: float
    y: float
    w: float
    h: float
    confidence: float
    #: the raw YuNet row (box, 5 landmarks, score) in the coordinates of the image that was passed in
    row: np.ndarray

    @property
    def area(self) -> float:
        return self.w * self.h

    @property
    def center(self) -> tuple[float, float]:
        return self.x + self.w / 2, self.y + self.h / 2

    def box(self) -> tuple[float, float, float, float]:
        return self.x, self.y, self.w, self.h


def _detect_once(models: FaceModels, image: np.ndarray) -> list[np.ndarray]:
    models.detector.setInputSize((image.shape[1], image.shape[0]))
    _, rows = models.detector.detect(image)
    return [] if rows is None else list(rows)


def detect_faces(models: FaceModels, image: np.ndarray) -> list[Face]:
    """Every face YuNet finds, largest first. Boxes are in the coordinates of `image`."""
    with models.lock:
        rows = _detect_once(models, image)
        if not rows:
            import cv2

            small = cv2.resize(image, None, fx=_RETRY_SCALE, fy=_RETRY_SCALE, interpolation=cv2.INTER_AREA)
            rows = [np.concatenate([r[:14] / _RETRY_SCALE, r[14:]]) for r in _detect_once(models, small)]
    faces = [Face(float(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[14]), np.asarray(r, dtype=np.float32)) for r in rows]
    return sorted(faces, key=lambda f: f.area, reverse=True)


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0
