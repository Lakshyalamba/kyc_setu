"""
Generates SYNTHETIC identity-card images for development and tests.

Every card is clearly fake ("SAMPLE DOCUMENT - NOT REAL"), uses invented data, and is drawn from
scratch. Never put a real document here, blurred or otherwise.

    uv run --project services/ai python scripts/sample-docs/make_samples.py

Outputs (next to this script): pan.png, aadhaar-front.png, aadhaar-back.png and expected.json.
Fonts come from the host (macOS: Helvetica + Kohinoor for Devanagari); override with
SAMPLE_LATIN_FONT / SAMPLE_DEVANAGARI_FONT. The generated PNGs are committed, so nobody else needs
to run this.
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).parent
W, H = 1400, 880
LATIN = os.environ.get("SAMPLE_LATIN_FONT", "/System/Library/Fonts/Helvetica.ttc")
DEVANAGARI = os.environ.get("SAMPLE_DEVANAGARI_FONT", "/System/Library/Fonts/Kohinoor.ttc")

# Invented identity. The Aadhaar number passes the Verhoeff checksum; it is not anyone's real number.
PERSON = {
    "name": "RAHUL KUMAR SHARMA",
    "fatherName": "SURESH KUMAR SHARMA",
    "dobDisplay": "15/05/1990",
    "dob": "1990-05-15",
    "panNumber": "ABCDE1234F",
    "aadhaarNumber": "234123412346",
    "gender": "MALE",
    "addressLines": ["S/O Suresh Kumar Sharma", "12 MG Road, Indiranagar", "Bengaluru, Karnataka - 560038"],
    "pincode": "560038",
}


def font(path: str, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size, index=index)


def card(bg: tuple[int, int, int], seed: int) -> Image.Image:
    """A softly shaded card background with a little sensor-like noise."""
    rng = random.Random(seed)
    img = Image.new("RGB", (W, H), bg)
    px = img.load()
    assert px is not None
    for y in range(H):
        shade = int(14 * (y / H))
        for x in range(0, W):
            n = rng.randint(-3, 3)
            r, g, b = bg
            px[x, y] = (max(r - shade + n, 0), max(g - shade + n, 0), max(b - shade + n, 0))
    return img


def banner(d: ImageDraw.ImageDraw) -> None:
    d.rectangle([0, H - 70, W, H], fill=(170, 30, 30))
    d.text((W // 2, H - 35), "SAMPLE DOCUMENT - NOT REAL", font=font(LATIN, 36), fill="white", anchor="mm")


def make_pan(dob_display: str | None = None) -> Image.Image:
    img = card((205, 220, 235), 1)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 130], fill=(40, 70, 130))
    d.text((60, 65), "INCOME TAX DEPARTMENT", font=font(LATIN, 52), fill="white", anchor="lm")
    d.text((W - 60, 65), "GOVT. OF INDIA", font=font(LATIN, 46), fill="white", anchor="rm")
    label, value, big = font(LATIN, 34), font(LATIN, 50), font(LATIN, 66)
    d.text((60, 175), "Permanent Account Number", font=label, fill=(50, 50, 50))
    d.text((60, 225), PERSON["panNumber"], font=big, fill=(10, 10, 10))
    d.text((60, 325), "Name", font=label, fill=(50, 50, 50))
    d.text((60, 370), PERSON["name"], font=value, fill=(10, 10, 10))
    d.text((60, 470), "Father's Name", font=label, fill=(50, 50, 50))
    d.text((60, 515), PERSON["fatherName"], font=value, fill=(10, 10, 10))
    d.text((60, 615), "Date of Birth", font=label, fill=(50, 50, 50))
    d.text((60, 660), dob_display or PERSON["dobDisplay"], font=value, fill=(10, 10, 10))
    d.rectangle([1000, 300, 1320, 640], outline=(90, 90, 90), width=3)  # photo placeholder
    banner(d)
    return img


def make_aadhaar_front(dob_display: str | None = None) -> Image.Image:
    img = card((250, 250, 245), 2)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 120], fill=(230, 120, 30))
    d.text((60, 60), "Government of India", font=font(LATIN, 52), fill="white", anchor="lm")
    d.text((W - 60, 60), "भारत सरकार", font=font(DEVANAGARI, 52), fill="white", anchor="rm")
    d.rectangle([60, 180, 330, 520], outline=(90, 90, 90), width=3)  # photo placeholder
    n = PERSON["aadhaarNumber"]
    d.text((380, 190), PERSON["name"].title(), font=font(LATIN, 56), fill=(10, 10, 10))
    d.text((380, 290), "DOB: " + (dob_display or PERSON["dobDisplay"]), font=font(LATIN, 48), fill=(10, 10, 10))
    d.text((380, 370), PERSON["gender"], font=font(LATIN, 48), fill=(10, 10, 10))
    d.text((380, 440), "पुरुष", font=font(DEVANAGARI, 44), fill=(10, 10, 10))
    d.text((W // 2, 640), f"{n[:4]} {n[4:8]} {n[8:]}", font=font(LATIN, 92), fill=(10, 10, 10), anchor="mm")
    d.line([60, 720, W - 60, 720], fill=(230, 120, 30), width=4)
    d.text((W // 2, 765), "आधार - आम आदमी का अधिकार", font=font(DEVANAGARI, 40), fill=(60, 60, 60), anchor="mm")
    banner(d)
    return img


def make_aadhaar_back() -> Image.Image:
    img = card((250, 250, 245), 3)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 120], fill=(230, 120, 30))
    d.text((60, 60), "Unique Identification Authority of India", font=font(LATIN, 46), fill="white", anchor="lm")
    d.text((60, 175), "Address:", font=font(LATIN, 48), fill=(10, 10, 10))
    y = 245
    for line in PERSON["addressLines"]:
        d.text((60, y), line, font=font(LATIN, 50), fill=(10, 10, 10))
        y += 75
    d.text((60, y + 20), "पता:", font=font(DEVANAGARI, 44), fill=(10, 10, 10))
    d.text((60, y + 85), "१२ एम जी रोड, इंदिरानगर, बेंगलुरु", font=font(DEVANAGARI, 44), fill=(10, 10, 10))
    n = PERSON["aadhaarNumber"]
    d.text((W // 2, 700), f"{n[:4]} {n[4:8]} {n[8:]}", font=font(LATIN, 80), fill=(10, 10, 10), anchor="mm")
    banner(d)
    return img


def make_signature() -> Image.Image:
    """A 600x200 transparent PNG with a handwritten-looking squiggle (what the signature pad exports)."""
    img = Image.new("RGBA", (600, 200), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = [(40 + i * 24, 110 + int(45 * __import__("math").sin(i * 0.9)) - (i % 3) * 6) for i in range(22)]
    d.line(pts, fill=(17, 24, 39, 255), width=4, joint="curve")
    d.line([(60, 150), (520, 140)], fill=(17, 24, 39, 255), width=3)
    return img


def main() -> None:
    for name, build in {"pan": make_pan, "aadhaar-front": make_aadhaar_front, "aadhaar-back": make_aadhaar_back}.items():
        # A touch of blur mimics a camera; the images stay comfortably above the sharpness gate.
        build().filter(ImageFilter.GaussianBlur(0.6)).save(OUT / f"{name}.png", optimize=True)
        print("wrote", OUT / f"{name}.png")
    make_signature().save(OUT / "signature.png", optimize=True)
    print("wrote", OUT / "signature.png")
    # Cards whose printed date of birth makes the holder a minor (born 2012-01-01: under 18 until 2030).
    make_pan("01/01/2012").filter(ImageFilter.GaussianBlur(0.6)).save(OUT / "pan-underage.png", optimize=True)
    make_aadhaar_front("01/01/2012").filter(ImageFilter.GaussianBlur(0.6)).save(OUT / "aadhaar-front-underage.png", optimize=True)
    print("wrote underage PAN and Aadhaar front")
    # A deliberately blurred PAN, for exercising the low-quality gate.
    make_pan().filter(ImageFilter.GaussianBlur(9)).save(OUT / "pan-blurred.png", optimize=True)
    print("wrote", OUT / "pan-blurred.png")
    expected = {
        "pan": {
            "name": PERSON["name"],
            "fatherName": PERSON["fatherName"],
            "dob": PERSON["dob"],
            "panNumber": PERSON["panNumber"],
        },
        "aadhaar-front": {
            "name": PERSON["name"],
            "dob": PERSON["dob"],
            "gender": PERSON["gender"],
            "aadhaarNumber": "XXXX-XXXX-" + PERSON["aadhaarNumber"][-4:],
        },
        "aadhaar-back": {"pincode": PERSON["pincode"], "addressContains": ["12 MG Road", "Bengaluru", "Karnataka"]},
    }
    (OUT / "expected.json").write_text(json.dumps(expected, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
