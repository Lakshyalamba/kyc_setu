"""
Generates SYNTHETIC identity-card images for development and tests.

Every card is clearly fake ("SAMPLE DOCUMENT - NOT REAL"), uses invented data, and is drawn from
scratch. Never put a real document here, blurred or otherwise.

    uv run --project services/ai python scripts/sample-docs/make_samples.py

Outputs (next to this script): pan.png, aadhaar-front.png, aadhaar-back.png and expected.json.

    ... make_samples.py --personas

additionally writes personas/<slug>/{pan,aadhaar-front,aadhaar-back}.png and personas.json: a handful of other invented
people, with the position of every printed field, for the officer-workbench seed (`pnpm seed`).
Fonts come from the host (macOS: Helvetica + Kohinoor for Devanagari); override with
SAMPLE_LATIN_FONT / SAMPLE_DEVANAGARI_FONT. The generated PNGs are committed, so nobody else needs
to run this.
"""

from __future__ import annotations

import json
import os
import random
import sys
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


def put(d: ImageDraw.ImageDraw, boxes: dict | None, key: str | None, xy, text: str, **kw) -> None:
    """Draws text and, if asked, records its box on the card as fractions of the image (x, y, w, h)."""
    d.text(xy, text, **kw)
    if boxes is not None and key:
        x0, y0, x1, y1 = d.textbbox(xy, text, font=kw["font"], anchor=kw.get("anchor"))
        pad = 6
        boxes[key] = {
            "x": round(max(x0 - pad, 0) / W, 4),
            "y": round(max(y0 - pad, 0) / H, 4),
            "w": round((x1 - x0 + 2 * pad) / W, 4),
            "h": round((y1 - y0 + 2 * pad) / H, 4),
        }


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


def make_pan(
    dob_display: str | None = None, person: dict | None = None, boxes: dict | None = None, avatar: Image.Image | None = None
) -> Image.Image:
    person = person or PERSON
    img = card((205, 220, 235), 1)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 130], fill=(40, 70, 130))
    d.text((60, 65), "INCOME TAX DEPARTMENT", font=font(LATIN, 52), fill="white", anchor="lm")
    d.text((W - 60, 65), "GOVT. OF INDIA", font=font(LATIN, 46), fill="white", anchor="rm")
    label, value, big = font(LATIN, 34), font(LATIN, 50), font(LATIN, 66)
    d.text((60, 175), "Permanent Account Number", font=label, fill=(50, 50, 50))
    put(d, boxes, "panNumber", (60, 225), person["panNumber"], font=big, fill=(10, 10, 10))
    d.text((60, 325), "Name", font=label, fill=(50, 50, 50))
    put(d, boxes, "name", (60, 370), person["name"], font=value, fill=(10, 10, 10))
    d.text((60, 470), "Father's Name", font=label, fill=(50, 50, 50))
    put(d, boxes, "fatherName", (60, 515), person["fatherName"], font=value, fill=(10, 10, 10))
    d.text((60, 615), "Date of Birth", font=label, fill=(50, 50, 50))
    put(d, boxes, "dob", (60, 660), dob_display or person["dobDisplay"], font=value, fill=(10, 10, 10))
    d.rectangle([1000, 300, 1320, 640], outline=(90, 90, 90), width=3)  # photo placeholder
    if avatar is not None:
        img.paste(avatar.resize((314, 334)), (1003, 303))
    banner(d)
    return img


def make_aadhaar_front(
    dob_display: str | None = None, person: dict | None = None, boxes: dict | None = None, avatar: Image.Image | None = None
) -> Image.Image:
    person = person or PERSON
    img = card((250, 250, 245), 2)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 120], fill=(230, 120, 30))
    d.text((60, 60), "Government of India", font=font(LATIN, 52), fill="white", anchor="lm")
    d.text((W - 60, 60), "भारत सरकार", font=font(DEVANAGARI, 52), fill="white", anchor="rm")
    d.rectangle([60, 180, 330, 520], outline=(90, 90, 90), width=3)  # photo placeholder
    if avatar is not None:
        img.paste(avatar.resize((264, 334)), (63, 183))
    n = person["aadhaarNumber"]
    put(d, boxes, "name", (380, 190), person["name"].title(), font=font(LATIN, 56), fill=(10, 10, 10))
    put(d, boxes, "dob", (380, 290), "DOB: " + (dob_display or person["dobDisplay"]), font=font(LATIN, 48), fill=(10, 10, 10))
    put(d, boxes, "gender", (380, 370), person["gender"], font=font(LATIN, 48), fill=(10, 10, 10))
    d.text((380, 440), "पुरुष" if person["gender"] == "MALE" else "महिला", font=font(DEVANAGARI, 44), fill=(10, 10, 10))
    put(d, boxes, "aadhaarNumber", (W // 2, 640), f"{n[:4]} {n[4:8]} {n[8:]}", font=font(LATIN, 92), fill=(10, 10, 10), anchor="mm")
    d.line([60, 720, W - 60, 720], fill=(230, 120, 30), width=4)
    d.text((W // 2, 765), "आधार - आम आदमी का अधिकार", font=font(DEVANAGARI, 40), fill=(60, 60, 60), anchor="mm")
    banner(d)
    return img


def make_aadhaar_back(person: dict | None = None, boxes: dict | None = None) -> Image.Image:
    person = person or PERSON
    img = card((250, 250, 245), 3)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 120], fill=(230, 120, 30))
    d.text((60, 60), "Unique Identification Authority of India", font=font(LATIN, 46), fill="white", anchor="lm")
    d.text((60, 175), "Address:", font=font(LATIN, 48), fill=(10, 10, 10))
    y = 245
    first_y = y
    for i, line in enumerate(person["addressLines"]):
        put(d, boxes, f"line{i}", (60, y), line, font=font(LATIN, 50), fill=(10, 10, 10))
        y += 75
    if boxes is not None:
        lines = [boxes.pop(f"line{i}") for i in range(len(person["addressLines"]))]
        x0 = min(b["x"] for b in lines)
        y0 = min(b["y"] for b in lines)
        boxes["address"] = {
            "x": x0,
            "y": y0,
            "w": round(max(b["x"] + b["w"] for b in lines) - x0, 4),
            "h": round(max(b["y"] + b["h"] for b in lines) - y0, 4),
        }
        boxes["pincode"] = lines[-1]
    d.text((60, y + 20), "पता:", font=font(DEVANAGARI, 44), fill=(10, 10, 10))
    d.text((60, y + 85), "१२ एम जी रोड, इंदिरानगर, बेंगलुरु", font=font(DEVANAGARI, 44), fill=(10, 10, 10))
    n = person["aadhaarNumber"]
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


# ---- Other invented people, for the officer-workbench seed -------------------------------------------------------
def _verhoeff_check_digit(digits: str) -> str:
    d = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
         [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]]
    p = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],
         [4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]]
    inv = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = d[c][p[(i + 1) % 8][int(ch)]]
    return str(inv[c])


def _person(name, father, dob, gender, city, state, pincode, pan, aadhaar_prefix, line1):
    y, m, dd = dob.split("-")
    return {
        "name": name,
        "fatherName": father,
        "dobDisplay": f"{dd}/{m}/{y}",
        "dob": dob,
        "panNumber": pan,
        "aadhaarNumber": aadhaar_prefix + _verhoeff_check_digit(aadhaar_prefix),
        "gender": gender,
        "addressLines": [f"S/O {father.title()}" if gender == "MALE" else f"D/O {father.title()}", line1, f"{city}, {state} - {pincode}"],
        "pincode": pincode,
        "city": city,
        "state": state,
        "line1": line1,
    }


# Every number is recognisably fake. PANs start TEST (so they match the real PAN pattern and can still be told apart at a
# glance); Aadhaar numbers start 9999 0000 and end in a valid Verhoeff check digit, so the form accepts them.
PERSONAS = {
    "anita-rao": _person("ANITA RAO", "RAMESH RAO", "1991-03-12", "FEMALE", "Pune", "Maharashtra", "411001", "TESTA1001L", "99990000001", "14 FC Road, Shivajinagar"),
    "meera-iyer": _person("MEERA IYER", "KRISHNAN IYER", "1988-07-22", "FEMALE", "Chennai", "Tamil Nadu", "600017", "TESTB1002C", "99990000002", "7 Usman Road, T Nagar"),
    "arjun-mehta": _person("ARJUN MEHTA", "DINESH MEHTA", "1985-11-03", "MALE", "Ahmedabad", "Gujarat", "380009", "TESTC1003H", "99990000003", "22 CG Road, Navrangpura"),
    "rohan-verma": _person("ROHAN VERMA", "SANJAY VERMA", "1979-01-30", "MALE", "Lucknow", "Uttar Pradesh", "226001", "TESTD1004N", "99990000004", "5 Hazratganj"),
    "kavita-nair": _person("KAVITA NAIR", "GOPAL NAIR", "1994-09-17", "FEMALE", "Kochi", "Kerala", "682001", "TESTE1005P", "99990000005", "31 MG Road, Ernakulam"),
    "sanjay-gupta": _person("SANJAY GUPTA", "MOHAN GUPTA", "1982-04-08", "MALE", "Jaipur", "Rajasthan", "302001", "TESTF1006K", "99990000006", "18 MI Road, Panch Batti"),
    "farah-khan": _person("FARAH KHAN", "IMRAN KHAN", "1990-12-25", "FEMALE", "Hyderabad", "Telangana", "500001", "TESTG1007M", "99990000007", "9 Abids Road, Nampally"),
}

# Which synthetic face is printed on a persona's cards, and which one "took the selfie". Three avatars, so a swap
# (card a, selfie c) is the face-mismatch scenario.
FACES = {
    "anita-rao": ("a", "a"),
    "meera-iyer": ("b", "b"),
    "arjun-mehta": ("c", "a"),  # a different face on the cards than in the selfie
    "rohan-verma": ("c", "c"),
    "kavita-nair": ("b", "b"),
    "sanjay-gupta": ("a", "a"),
    "farah-khan": ("b", "c"),
}

AVATARS = {
    "a": {"seed": 11, "skin": (224, 172, 125), "hair": (40, 28, 22), "bg": (186, 214, 236)},
    "b": {"seed": 23, "skin": (198, 134, 94), "hair": (20, 18, 18), "bg": (236, 208, 190)},
    "c": {"seed": 37, "skin": (240, 200, 168), "hair": (120, 70, 36), "bg": (200, 226, 200)},
}


def make_avatar(key: str, size: tuple[int, int] = (360, 440), jitter: int = 0) -> Image.Image:
    """A cartoon face: an oval, hair, eyes, a mouth and a few random shapes. Obviously not a photograph of anyone."""
    spec = AVATARS[key]
    rng = random.Random(spec["seed"] + jitter)
    w, h = size
    img = Image.new("RGB", size, spec["bg"])
    d = ImageDraw.Draw(img)
    for _ in range(5):  # background confetti: circles and triangles in muted colours
        x, y, r = rng.randint(0, w), rng.randint(0, h // 2), rng.randint(18, 50)
        tone = tuple(max(0, min(255, c + rng.randint(-40, 25))) for c in spec["bg"])
        if rng.random() < 0.5:
            d.ellipse([x - r, y - r, x + r, y + r], fill=tone)
        else:
            d.polygon([(x, y - r), (x - r, y + r), (x + r, y + r)], fill=tone)
    cx = w // 2 + (jitter * 3 % 9) - 4
    d.ellipse([cx - w * 0.30, h * 0.14, cx + w * 0.30, h * 0.76], fill=spec["hair"])  # hair behind the face
    d.rectangle([cx - w * 0.07, h * 0.66, cx + w * 0.07, h * 0.84], fill=spec["skin"])  # neck
    d.ellipse([cx - w * 0.60 * 0.5, h * 0.60, cx + w * 0.60 * 0.5, h * 1.1], fill=(70, 90, 140))  # shoulders
    d.ellipse([cx - w * 0.24, h * 0.22, cx + w * 0.24, h * 0.70], fill=spec["skin"])  # face
    d.pieslice([cx - w * 0.28, h * 0.10, cx + w * 0.28, h * 0.50], 180, 360, fill=spec["hair"])  # fringe
    ey = h * 0.44
    for sx in (-1, 1):
        ex = cx + sx * w * 0.10
        d.ellipse([ex - 14, ey - 9, ex + 14, ey + 9], fill="white")
        d.ellipse([ex - 6, ey - 6, ex + 6, ey + 6], fill=(30, 30, 40))
        d.line([ex - 18, ey - 24, ex + 18, ey - 24 + sx * 3], fill=spec["hair"], width=5)
    d.line([cx, h * 0.46, cx - 6, h * 0.54, cx + 6, h * 0.54], fill=tuple(int(c * 0.8) for c in spec["skin"]), width=4)
    d.arc([cx - w * 0.09, h * 0.54, cx + w * 0.09, h * 0.64], 20, 160, fill=(120, 40, 50), width=5)
    d.rectangle([0, h - 44, w, h], fill=(170, 30, 30))
    label = f"SYNTHETIC AVATAR {key.upper()}" + ("" if w < 400 else " - NOT A REAL PERSON")
    d.text((w // 2, h - 22), label, font=font(LATIN, 17), fill="white", anchor="mm")
    return img


def make_avatars() -> None:
    folder = OUT / "avatars"
    folder.mkdir(exist_ok=True)
    for key in AVATARS:
        make_avatar(key).save(folder / f"avatar-{key}.png", optimize=True)
        print("wrote", folder / f"avatar-{key}.png")


def make_personas() -> None:
    make_avatars()
    out = OUT / "personas"
    index = {}
    for slug, person in PERSONAS.items():
        folder = out / slug
        folder.mkdir(parents=True, exist_ok=True)
        boxes: dict = {"PAN": {}, "AADHAAR_FRONT": {}, "AADHAAR_BACK": {}}
        card_face, selfie_face = FACES[slug]
        card_avatar = make_avatar(card_face, (320, 400))
        cards = {
            "pan": make_pan(person=person, boxes=boxes["PAN"], avatar=card_avatar),
            "aadhaar-front": make_aadhaar_front(person=person, boxes=boxes["AADHAAR_FRONT"], avatar=card_avatar),
            "aadhaar-back": make_aadhaar_back(person=person, boxes=boxes["AADHAAR_BACK"]),
        }
        # The "selfie": the same synthetic face, redrawn a touch differently, as if it were taken today.
        make_avatar(selfie_face, (540, 660), jitter=1).filter(ImageFilter.GaussianBlur(0.4)).save(folder / "selfie.png", optimize=True)
        for name, img in cards.items():
            img.filter(ImageFilter.GaussianBlur(0.6)).save(folder / f"{name}.png", optimize=True)
        index[slug] = {k: v for k, v in person.items() if k != "addressLines"} | {
            "addressLines": person["addressLines"],
            "faces": {"card": card_face, "selfie": selfie_face},
            "boxes": boxes,
        }
        print("wrote", folder)
    (OUT / "personas.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")


def main() -> None:
    if "--personas" in sys.argv:
        make_personas()
        return
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
