"""Caption cards and phone-clip backgrounds for docs/media/full-flow.gif (see scripts/make-demo-gif.sh).

    uv run --project services/ai python scripts/demo/make_frames.py <out-dir>

Everything is drawn here, not typed into ffmpeg, so the GIF needs no font support in the ffmpeg build. Fonts come from the
host (macOS Helvetica); override with SAMPLE_LATIN_FONT.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 900, 560
BG = (20, 22, 29)
INK = (236, 238, 246)
MUTED = (163, 171, 189)
ACCENT = (130, 168, 253)
LATIN = os.environ.get("SAMPLE_LATIN_FONT", "/System/Library/Fonts/Helvetica.ttc")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(LATIN, size, index=1 if bold else 0)
    except OSError:
        return ImageFont.load_default()


def wrap(draw: ImageDraw.ImageDraw, text: str, f, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + ([line] if line else [])


def card(title: str, body: str, step: str = "") -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([60, 180, 108, 228], 10, fill=(30, 65, 168))
    d.text((84, 204), "KS", font=font(20, True), fill="white", anchor="mm")
    y = 262
    if step:
        d.text((60, y), step, font=font(18, True), fill=ACCENT)
        y += 34
    for line in wrap(d, title, font(34, True), W - 120):
        d.text((60, y), line, font=font(34, True), fill=INK)
        y += 42
    y += 8
    for line in wrap(d, body, font(20), W - 120):
        d.text((60, y), line, font=font(20), fill=MUTED)
        y += 28
    return img


def phone_background(step: str, title: str, body: str) -> Image.Image:
    """The phone video sits on the left (overlaid by ffmpeg); the caption fills the right."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    x = 400
    d.text((x, 190), step, font=font(18, True), fill=ACCENT)
    y = 226
    for line in wrap(d, title, font(30, True), W - x - 40):
        d.text((x, y), line, font=font(30, True), fill=INK)
        y += 38
    y += 8
    for line in wrap(d, body, font(19), W - x - 40):
        d.text((x, y), line, font=font(19), fill=MUTED)
        y += 27
    return img


def bar(text: str) -> Image.Image:
    """A caption strip laid over the bottom of a desktop clip."""
    img = Image.new("RGBA", (W, 44), (20, 22, 29, 235))
    d = ImageDraw.Draw(img)
    d.text((16, 22), text, font=font(18, True), fill=INK, anchor="lm")
    return img


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    card("A customer, an officer and an auditor", "One application, from sign-up to a signed record. Everything on screen is synthetic.", "KYC Setu").save(out / "card-0-intro.png")
    phone_background("1", "A customer signs up on a phone", "Mobile OTP, consent, personal details, then four documents: PAN, both sides of the Aadhaar, a signature.").save(out / "phone-1.png")
    card("The worker reads the documents with OCR", "The selfie step is not built, so a development endpoint records the face-match and liveness signals it would have produced.", "Meanwhile").save(out / "card-1-ocr.png")
    phone_background("2", "Under review", "The customer sees that the application is with an officer. Nothing about risk is shown to them.").save(out / "phone-2.png")
    bar("3  An officer reviews the evidence and the risk breakdown, then approves").save(out / "bar-3.png")
    phone_background("4", "The customer is told", "Approved, with a reference id and a slip to download.").save(out / "phone-4.png")
    bar("5  An auditor verifies the audit chain: every closed day passes").save(out / "bar-5.png")
    card("Everything is recorded, and checkable", "Append-only audit log, hash chain, signed packets. Not a licensed KYC provider; a demonstration.", "The end").save(out / "card-9-end.png")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
