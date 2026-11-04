"""Draws the one committed attack fixture: a printed grey card with a (cartoon) face on it, as a camera might see it.

It is obviously synthetic: a cartoon avatar on a flat grey card with a white border, slight blur and sensor-like noise, on a dark
table. It is NOT a measurement of anything; real attack samples (printed selfies, phone-screen replays) are never committed
(see docs/calibration.md). Deterministic: run it again and the PNG is byte-identical.
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
avatar = Image.open(ROOT / "scripts/sample-docs/avatars/avatar-a.png").convert("RGB")
W, H = 640, 480
table = Image.new("RGB", (W, H), (38, 36, 34))
card = Image.new("RGB", (330, 420), (205, 205, 205))
card.paste(Image.new("RGB", (310, 400), (140, 140, 140)), (10, 10))
face = avatar.resize((260, int(260 * avatar.height / avatar.width)))
card.paste(face, (35, 40))
table.paste(card, ((W - 330) // 2, 30))
img = table.filter(ImageFilter.GaussianBlur(0.8))
arr = np.asarray(img).astype(np.float32)
arr += np.random.default_rng(7).normal(0, 3.0, arr.shape)
out = Path(__file__).resolve().parents[1] / "tests/fixtures/pad-attack-grey-card.png"
Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(out, optimize=True)
print(out, out.stat().st_size, "bytes")
