"""One-off: turn the two published MiniFASNet checkpoints into ONNX, so the service runs them with cv2.dnn and ships no PyTorch.

    uv run --with torch --with onnx python scripts/convert_minifasnet.py

The checkpoints are downloaded from the pinned upstream commit and refused unless their SHA-256 matches. The ONNX files land in
`pad_models/` and are committed (about 1.8 MB each) so the image build needs no network for them. The script then runs both
formats on the same random inputs and fails if they disagree, which is what makes the conversion trustworthy. Run it again only
to reproduce; ONNX bytes can differ between torch versions, so `pad_models/SHA256SUMS` is the record of what is shipped.
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
from vendor import minifasnet_arch as arch  # noqa: E402

UPSTREAM_COMMIT = "b6d5f04ad78778917853b25c778acef6d5626d15"
BASE = f"https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/{UPSTREAM_COMMIT}/resources/anti_spoof_models"
# name -> (builder, upstream .pth sha256). The file name encodes the crop scale and the input size: <scale>_<h>x<w>_<arch>.pth.
MODELS = {
    "2.7_80x80_MiniFASNetV2": (arch.MiniFASNetV2, "a5eb02e1843f19b5386b953cc4c9f011c3f985d0ee2bb9819eea9a142099bec0"),
    "4_0_0_80x80_MiniFASNetV1SE": (arch.MiniFASNetV1SE, "84ee1d37d96894d5e82de5a57df044ef80a58be2b218b5ed7cdfd875ec2f5990"),
}
OUT = Path(__file__).resolve().parent.parent / "pad_models"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    OUT.mkdir(exist_ok=True)
    sums = []
    for name, (builder, want) in MODELS.items():
        raw = urllib.request.urlopen(f"{BASE}/{name}.pth", timeout=60).read()  # noqa: S310 - pinned https URL
        if sha256(raw) != want:
            raise SystemExit(f"{name}.pth does not match the pinned hash: {sha256(raw)}")
        sums.append(f"{want}  {name}.pth (upstream, not shipped)")
        net = builder(conv6_kernel=((80 + 15) // 16, (80 + 15) // 16))
        state = torch.load(__import__("io").BytesIO(raw), map_location="cpu")
        net.load_state_dict({k.removeprefix("module."): v for k, v in state.items()})
        net.eval()
        path = OUT / f"{name}.onnx"
        torch.onnx.export(net, torch.zeros(1, 3, 80, 80), str(path), input_names=["input"], output_names=["logits"], opset_version=13, dynamo=False)
        cv = cv2.dnn.readNetFromONNX(str(path))
        rng = np.random.default_rng(0)
        worst = 0.0
        for _ in range(20):
            x = rng.integers(0, 256, size=(1, 3, 80, 80)).astype(np.float32)
            with torch.no_grad():
                a = net(torch.from_numpy(x)).numpy()
            cv.setInput(x)
            b = cv.forward()
            worst = max(worst, float(np.abs(a - b).max()))
        if worst > 1e-3:
            raise SystemExit(f"{name}: ONNX and torch disagree by {worst}")
        sums.append(f"{sha256(path.read_bytes())}  {path.name}")
        print(f"{name}: ok, largest logit difference torch vs cv2.dnn {worst:.2e}")
    (OUT / "SHA256SUMS").write_text("\n".join(sums) + "\n")
    print((OUT / "SHA256SUMS").read_text())


if __name__ == "__main__":
    main()
