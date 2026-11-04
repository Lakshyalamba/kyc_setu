"""Passive presentation-attack detection (PAD): is the face in this picture a live face, or a picture of one?

Two MiniFASNet networks (Minivision, Apache-2.0) look at 80x80 crops of the same detected face, one cut with 2.7x the face box
around it and one with 4x. Each says how likely "live" is; the score is the geometric mean of the two. The weights are the
published ones, converted to ONNX once (scripts/convert_minifasnet.py) and run with cv2.dnn.

WHAT THIS IS NOT. It is not certified anti-spoofing and it was not calibrated on this project's cameras. What data the weights
were trained on is not disclosed upstream, the face is cropped by YuNet and not by the RetinaFace the networks were trained
with, and a single webcam-style frame is all it sees. It lowers the chance that a printed photo or a phone screen passes; it
says nothing about masks, replays injected at the camera, or deepfakes. Every label that shows its result says so.
"""

from __future__ import annotations

import hashlib
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from app.face.detect import detect_faces
from app.face.models import FaceModels

# name -> (crop scale around the face box, SHA-256 of the ONNX file). The .pth hashes they were converted from are in
# pad_models/SHA256SUMS and services/ai/README.md.
MODELS = {
    "2.7_80x80_MiniFASNetV2.onnx": (2.7, "1cb86b65b7e204950a10a868049e1012c0892f6f908dc93587f29cf3b3794419"),
    "4_0_0_80x80_MiniFASNetV1SE.onnx": (4.0, "0a4539e34fd8428967614df33657edbc8ffc0404049104a22dc7eb1589f378a9"),
}
SUB_KEYS = ("scale2_7", "scale4_0")  # in MODELS order; the names say what the crop is, not how good it is
MODEL_VERSION = "minifasnet-v2-2.7+v1se-4.0:silent-face-anti-spoofing-b6d5f04:yunet-2023mar"
INPUT_SIZE = 80
LIVE_CLASS = 1  # the three outputs are spoof / live / spoof; upstream's test.py takes index 1 as the real face


class PadModelError(RuntimeError):
    pass


@dataclass
class PadModels:
    nets: list["cv2.dnn.Net"]
    weights_hash: str
    # cv2.dnn nets keep their input as state, so one request at a time.
    lock: threading.Lock

    @property
    def status(self) -> dict[str, str]:
        return {"pad-minifasnet-v2": "loaded", "pad-minifasnet-v1se": "loaded"}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_pad_models(model_dir: str | Path) -> PadModels:
    folder = Path(model_dir)
    nets, hashes = [], []
    for name, (_, expected) in MODELS.items():
        path = folder / name
        if not path.exists():
            raise PadModelError(f"{name} is missing from {folder}")
        digest = _sha256(path)
        if digest != expected:
            raise PadModelError(f"{name} does not match its known SHA-256; refusing to load it")
        nets.append(cv2.dnn.readNetFromONNX(str(path)))
        hashes.append(digest)
    # One hash for the pair, stored with every result so a score can be traced to the exact files that produced it.
    return PadModels(nets=nets, weights_hash=hashlib.sha256(":".join(hashes).encode()).hexdigest(), lock=threading.Lock())


def crop_for_scale(image: np.ndarray, box: tuple[float, float, float, float], scale: float) -> np.ndarray:
    """The 80x80 crop upstream feeds a network: the face box grown by `scale` (capped so it fits), shifted back inside the picture."""
    height, width = image.shape[:2]
    x, y, w, h = box
    scale = min((height - 1) / h, (width - 1) / w, scale)
    new_w, new_h = w * scale, h * scale
    cx, cy = x + w / 2, y + h / 2
    left, top, right, bottom = cx - new_w / 2, cy - new_h / 2, cx + new_w / 2, cy + new_h / 2
    if left < 0:
        right, left = right - left, 0
    if top < 0:
        bottom, top = bottom - top, 0
    if right > width - 1:
        left, right = left - (right - width + 1), width - 1
    if bottom > height - 1:
        top, bottom = top - (bottom - height + 1), height - 1
    patch = image[int(top) : int(bottom) + 1, int(left) : int(right) + 1]
    return cv2.resize(patch, (INPUT_SIZE, INPUT_SIZE))


def _live_probability(net: "cv2.dnn.Net", patch_bgr: np.ndarray) -> float:
    # Upstream feeds raw 0..255 BGR as float32: no mean, no scaling. Anything else changes the scores.
    blob = patch_bgr.astype(np.float32).transpose(2, 0, 1)[None]
    net.setInput(blob)
    logits = net.forward()[0].astype(np.float64)
    exp = np.exp(logits - logits.max())
    return float((exp / exp.sum())[LIVE_CLASS])


def decide(score: float, pass_threshold: float, fail_threshold: float) -> str:
    """LIVE at or above `pass_threshold`, SPOOF below `fail_threshold`, BORDERLINE between (a person should look)."""
    if score >= pass_threshold:
        return "LIVE"
    return "BORDERLINE" if score >= fail_threshold else "SPOOF"


def run_passive_pad(
    faces: FaceModels,
    pad: PadModels,
    image: np.ndarray,
    *,
    pass_threshold: float,
    fail_threshold: float,
    ambiguous_ratio: float = 0.6,
) -> dict:
    """Returns the fields of the `PadResult` contract. Never raises for a picture it cannot judge: it says why."""
    started = time.perf_counter()

    def out(decision: str, reason: str | None, score: float | None = None, subs: dict | None = None) -> dict:
        return {
            "score": None if score is None else round(score, 4),
            "decision": decision,
            "reason": reason,
            "subScores": subs or {},
            "passThreshold": pass_threshold,
            "failThreshold": fail_threshold,
            "modelVersion": MODEL_VERSION,
            "modelWeightsHash": pad.weights_hash,
            "latencyMs": round((time.perf_counter() - started) * 1000, 1),
        }

    found = detect_faces(faces, image)
    if not found:
        return out("UNAVAILABLE", "NO_FACE")
    if len(found) > 1 and found[1].area >= ambiguous_ratio * found[0].area:
        return out("UNAVAILABLE", "AMBIGUOUS_FACES")
    box = found[0].box()
    with pad.lock:
        probabilities = [
            _live_probability(net, crop_for_scale(image, box, scale))
            for net, (scale, _) in zip(pad.nets, MODELS.values(), strict=True)
        ]
    score = float(np.sqrt(np.prod(probabilities)))
    subs = {key: round(p, 4) for key, p in zip(SUB_KEYS, probabilities, strict=True)}
    return out(decide(score, pass_threshold, fail_threshold), None, score, subs)
