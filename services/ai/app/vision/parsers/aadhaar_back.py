"""Aadhaar back: the address block (English lines) and its 6-digit pincode."""

from __future__ import annotations

import re

from app.vision.ocr import Line
from app.vision.parsers.common import (
    FieldResult,
    ParseResult,
    has_marker,
    squash,
    strip_non_latin,
    union_box,
)

_MARKERS = ("address", "unique identification authority", "uidai", "पता")
_PINCODE_RE = re.compile(r"(?<!\d)([1-9]\d{5})(?!\d)")
_STOP_WORDS = ("sample", "help@uidai", "www.", "vid", "1947")
_AADHAAR_RE = re.compile(r"(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)")


def parse_aadhaar_back(lines: list[Line]) -> ParseResult:
    if not has_marker(lines, *_MARKERS):
        return ParseResult("wrong_document")

    english = [ln for ln in lines if strip_non_latin(ln.text).strip() == ln.text.strip()]
    start = next((i for i, ln in enumerate(english) if squash(ln.text).startswith("address")), None)
    if start is None:
        return ParseResult("parse_failed")

    block: list[Line] = []
    for line in english[start + 1 :]:
        low = line.text.lower()
        if _AADHAAR_RE.search(line.text) or any(w in low for w in _STOP_WORDS):
            break
        block.append(line)
        if _PINCODE_RE.search(line.text):  # the address ends at the line carrying the pincode
            break
    # Text on the "Address:" line itself ("Address: S/O ...").
    first = re.sub(r"^\s*address\s*[:\-]?\s*", "", english[start].text, flags=re.IGNORECASE).strip()
    if first:
        block.insert(0, Line(first, english[start].box, english[start].confidence))
    if not block:
        return ParseResult("parse_failed")

    pincode: FieldResult | None = None
    for line in reversed(block):
        matches = _PINCODE_RE.findall(line.text)
        if matches:
            pincode = FieldResult(matches[-1], line.confidence, line.box)
            break

    text = ", ".join(ln.text.strip().rstrip(",") for ln in block)
    text = re.sub(r"[\s,\-]*\b[1-9]\d{5}\b\s*$", "", text).strip(" ,-")  # pincode is its own field
    confidence = sum(ln.confidence for ln in block) / len(block)
    fields = {"address": FieldResult(text, round(confidence, 4), union_box([ln.box for ln in block]))}
    if pincode:
        fields["pincode"] = pincode
    return ParseResult("ok" if pincode and len(text) >= 8 else "parse_failed", fields)
