"""The two face models, loaded once at process start.

YuNet (detector, MIT) and SFace (recogniser, Apache-2.0) come from the OpenCV Zoo and run through the `cv2` that PaddleOCR
already installs, so there is no second inference runtime. The weights are NOT in git: `scripts/download_face_models.py` fetches
them, checks the SHA-256 below and puts them in `AI_FACE_MODEL_DIR`; the Docker build runs it. See services/ai/README.md for the
licence of each file and what is and is not known about how the recogniser was trained.
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2

DETECTOR_FILE = "face_detection_yunet_2023mar.onnx"
RECOGNIZER_FILE = "face_recognition_sface_2021dec.onnx"

# Verified when the weights were first downloaded (2026-11-03). A file that does not match is refused, not used.
SHA256 = {
    DETECTOR_FILE: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    RECOGNIZER_FILE: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
}

# Stored with every face match, so a model upgrade can tell which rows to recompute.
EMBEDDING_VERSION = "yunet-2023mar+sface-2021dec"


class FaceModelError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass
class FaceModels:
    detector: "cv2.FaceDetectorYN"
    recognizer: "cv2.FaceRecognizerSF"
    # OpenCV's detector keeps its input size as state, so one request at a time.
    lock: threading.Lock

    @property
    def status(self) -> dict[str, str]:
        return {"face-detector": "loaded", "face-recognizer": "loaded"}

    @property
    def versions(self) -> dict[str, str]:
        return {"face-embedding": EMBEDDING_VERSION}


def load_face_models(model_dir: str | Path, *, min_confidence: float = 0.6) -> FaceModels:
    folder = Path(model_dir)
    for name, expected in SHA256.items():
        path = folder / name
        if not path.exists():
            raise FaceModelError(f"{name} is missing from {folder}; run scripts/download_face_models.py")
        if _sha256(path) != expected:
            raise FaceModelError(f"{name} does not match its known SHA-256; refusing to load it")
    detector = cv2.FaceDetectorYN.create(str(folder / DETECTOR_FILE), "", (320, 320), min_confidence, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(str(folder / RECOGNIZER_FILE), "")
    return FaceModels(detector=detector, recognizer=recognizer, lock=threading.Lock())
