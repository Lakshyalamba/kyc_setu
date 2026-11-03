"""Fetches the two face-model weight files into AI_FACE_MODEL_DIR (default services/ai/models) and checks their SHA-256.

    uv run python scripts/download_face_models.py

Idempotent: a file that is already there and matches is left alone. The Docker build runs this so the weights are baked
into the image. The weights are not committed. Licences, and what is not known about the training data: see README.md.
"""

from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.face.models import DETECTOR_FILE, RECOGNIZER_FILE, SHA256, _sha256  # noqa: E402

BASE = "https://github.com/opencv/opencv_zoo/raw/main/models"
SOURCES = {
    DETECTOR_FILE: f"{BASE}/face_detection_yunet/{DETECTOR_FILE}",  # MIT
    RECOGNIZER_FILE: f"{BASE}/face_recognition_sface/{RECOGNIZER_FILE}",  # Apache-2.0
}


def main() -> int:
    folder = Path(os.environ.get("AI_FACE_MODEL_DIR", Path(__file__).resolve().parent.parent / "models"))
    folder.mkdir(parents=True, exist_ok=True)
    for name, url in SOURCES.items():
        target = folder / name
        if target.exists() and _sha256(target) == SHA256[name]:
            print(f"ok      {name}")
            continue
        print(f"fetch   {name}  <-  {url}")
        urllib.request.urlretrieve(url, target)  # noqa: S310 - fixed https URLs above
        got = _sha256(target)
        if got != SHA256[name]:
            target.unlink()
            print(f"FAILED  {name}: SHA-256 {got} is not the expected {SHA256[name]}", file=sys.stderr)
            return 1
        print(f"ok      {name}  ({target.stat().st_size} bytes, sha256 verified)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
