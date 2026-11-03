"""Compare the face on an ID document with a selfie.

Both faces are aligned to 112x112 from YuNet's five landmarks (OpenCV's own alignment for SFace), embedded, L2-normalised and
compared by cosine similarity. SCORE CONVENTION: the cosine is signed (-1..1); the score is max(0, cosine), NOT (cosine + 1) / 2,
which would put unrelated faces at about 0.5. SFace's published same-person operating point is a cosine of 0.363.
The service returns evidence; the decision is made by the caller from packages/shared/src/face/thresholds.ts.
"""

from __future__ import annotations

import base64

import cv2
import numpy as np

from app.config import Settings
from app.face.detect import Face, detect_faces
from app.face.models import EMBEDDING_VERSION, FaceModels


def _embed(models: FaceModels, image: np.ndarray, face: Face) -> tuple[np.ndarray, np.ndarray]:
    """(aligned 112x112 BGR crop, L2-normalised float32 embedding)."""
    with models.lock:
        aligned = models.recognizer.alignCrop(image, face.row)
        feature = models.recognizer.feature(aligned).reshape(-1).astype(np.float32)
    norm = float(np.linalg.norm(feature))
    return aligned, feature / norm if norm > 0 else feature


def _png_b64(image: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", image)
    if not ok:  # an in-memory encode of a valid array does not fail
        raise RuntimeError("could not encode the face crop")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def _f32_b64(vector: np.ndarray) -> str:
    return base64.b64encode(vector.astype("<f4").tobytes()).decode("ascii")


def match_faces(
    models: FaceModels, id_image: np.ndarray, selfie: np.ndarray, settings: Settings
) -> dict:
    """Returns the fields of the `FaceMatchResponse` contract (without the two ids)."""
    base = {
        "embeddingVersion": EMBEDDING_VERSION,
        "idFaceCropPng": None,
        "selfieFaceCropPng": None,
        "idEmbedding": None,
        "selfieEmbedding": None,
    }

    id_faces = detect_faces(models, id_image)
    if not id_faces:
        return {**base, "score": 0.0, "reason": "no_face_in_id"}
    selfie_faces = detect_faces(models, selfie)
    if not selfie_faces:
        return {**base, "score": 0.0, "reason": "no_face_in_selfie"}
    if len(selfie_faces) > 1 and selfie_faces[1].area >= settings.ambiguous_face_ratio * selfie_faces[0].area:
        return {**base, "score": 0.0, "reason": "ambiguous_selfie"}

    # ID photos tend to have one dominant face: the largest.
    id_crop, id_vec = _embed(models, id_image, id_faces[0])
    selfie_crop, selfie_vec = _embed(models, selfie, selfie_faces[0])
    cosine = float(np.dot(id_vec, selfie_vec))
    return {
        **base,
        "score": round(min(1.0, max(0.0, cosine)), 4),
        "reason": None,
        "idFaceCropPng": _png_b64(id_crop),
        "selfieFaceCropPng": _png_b64(selfie_crop),
        "idEmbedding": _f32_b64(id_vec),
        "selfieEmbedding": _f32_b64(selfie_vec),
    }
