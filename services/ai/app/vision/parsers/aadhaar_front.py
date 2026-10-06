"""Aadhaar front: 12-digit number (always returned masked), name, date of birth, gender."""

from __future__ import annotations

import re

from app.vision.ocr import Line
from app.vision.parsers.common import (
    FieldResult,
    ParseResult,
    has_marker,
    mostly_letters,
    normalize_name,
    parse_date,
    squash,
    strip_non_latin,
)
from app.vision.parsers.verhoeff import verhoeff_valid

_MARKERS = ("government of india", "aadhaar", "uidai", "unique identification", "bharat sarkar")
_HEADER_NOISE = ("government", "india", "aadhaar", "uidai", "authority", "identification", "sample", "document")
_NUMBER_RE = re.compile(r"(?<!\d)([2-9]\d{3})\s?(\d{4})\s?(\d{4})(?!\d)")
_MALE = re.compile(r"(?<![A-Za-z])MALE(?![A-Za-z])|पुरुष|पुरूष", re.IGNORECASE)
_FEMALE = re.compile(r"FEMALE|महिला|स्त्री", re.IGNORECASE)
_OTHER = re.compile(r"TRANSGENDER|ट्रांसजेंडर", re.IGNORECASE)


def mask_aadhaar(number: str) -> str:
    return f"XXXX-XXXX-{number[-4:]}"


def find_aadhaar_number(lines: list[Line]) -> tuple[str, Line, float] | None:
    """Looks for the number in single lines. Rows were already merged, so '2341 2341 2346' is one line."""
    for line in lines:
        match = _NUMBER_RE.search(line.text)
        if match:
            number = "".join(match.groups())
            # An invalid checksum usually means an OCR slip; keep the number but trust it less.
            certainty = 1.0 if verhoeff_valid(number) else 0.6
            return number, line, certainty
    return None


def _find_gender(lines: list[Line]) -> FieldResult | None:
    # Order matters: "FEMALE" contains "MALE", so test it first.
    for value, pattern in (("FEMALE", _FEMALE), ("MALE", _MALE), ("OTHER", _OTHER)):
        for line in lines:
            if pattern.search(line.text):
                return FieldResult(value, line.confidence, line.box)
    return None


def _find_dob(lines: list[Line]) -> tuple[FieldResult | None, int | None]:
    """Prefers a date on a DOB/'Date of Birth' line; otherwise the first valid date on the card."""
    dated = [(i, line, parse_date(line.text)) for i, line in enumerate(lines)]
    dated = [(i, line, iso) for i, line, iso in dated if iso]
    labelled = [d for d in dated if re.search(r"dob|birth|जन्म", d[1].text, re.IGNORECASE)]
    chosen = (labelled or dated or [None])[0]
    if chosen is None:
        return None, None
    i, line, iso = chosen
    return FieldResult(iso, line.confidence, line.box), i


def _find_name(lines: list[Line], dob_index: int | None) -> FieldResult | None:
    """The name is the Latin-script line just above the date of birth."""
    if dob_index is None:
        return None
    for i in range(dob_index - 1, -1, -1):
        text = strip_non_latin(lines[i].text).strip()
        if not text or any(noise in squash(text) for noise in _HEADER_NOISE) or not mostly_letters(text):
            continue
        name = normalize_name(text)
        if len(name) >= 3:
            return FieldResult(name, lines[i].confidence, lines[i].box)
    return None


def parse_aadhaar_front(lines: list[Line]) -> ParseResult:
    found = find_aadhaar_number(lines)
    dob, dob_index = _find_dob(lines)
    if not found and not has_marker(lines, *_MARKERS):
        return ParseResult("wrong_document")

    fields: dict[str, FieldResult] = {}
    warnings: list[str] = []
    if found:
        number, line, certainty = found
        fields["aadhaarNumber"] = FieldResult(mask_aadhaar(number), round(line.confidence * certainty, 4), line.box)
        if certainty < 1.0:
            warnings.append("AADHAAR_CHECKSUM_FAILED")
    if dob:
        fields["dob"] = dob
    name = _find_name(lines, dob_index)
    if name:
        fields["name"] = name
    gender = _find_gender(lines)
    if gender:
        fields["gender"] = gender

    complete = all(k in fields for k in ("aadhaarNumber", "name", "dob"))
    return ParseResult("ok" if complete else "parse_failed", fields, warnings)
