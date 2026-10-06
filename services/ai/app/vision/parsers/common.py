"""Shared helpers for the document parsers: normalisation, dates, line lookups."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from app.vision.ocr import Line

Status = str  # "ok" | "parse_failed" | "wrong_document"

_TITLES = {"MR", "MRS", "MS", "MISS", "SHRI", "SMT", "SRI", "SH", "KUMARI", "KU", "DR", "PROF", "LATE"}


@dataclass
class FieldResult:
    value: str
    confidence: float
    box: tuple[int, int, int, int]  # pixels of the deskewed image


@dataclass
class ParseResult:
    status: Status
    fields: dict[str, FieldResult] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def squash(text: str) -> str:
    """Lowercase letters/digits only. Makes marker matching robust to OCR dropping spaces ('DateofBirth')."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def has_marker(lines: list[Line], *markers: str) -> bool:
    """True if any marker appears in the text. Latin markers are matched ignoring case/spacing/punctuation;
    markers in other scripts (e.g. Devanagari) are matched literally, because squashing would erase them."""
    joined = " ".join(line.text for line in lines)
    haystack = squash(joined)
    for marker in markers:
        key = squash(marker)
        if key:
            if key in haystack:
                return True
        elif marker in joined:
            return True
    return False


def normalize_name(raw: str) -> str:
    """Strips titles, digits and punctuation noise; collapses whitespace; uppercases."""
    cleaned = re.sub(r"[^A-Za-z .'-]", " ", raw)
    words = [w for w in re.split(r"\s+", cleaned.strip()) if w]
    while words and words[0].rstrip(".").upper() in _TITLES:
        words.pop(0)
    return " ".join(words).upper().strip(" .-'")


def strip_non_latin(text: str) -> str:
    """Removes Devanagari and other non-Latin script (e.g. the 'आधार' header noise)."""
    return re.sub(r"[^\x00-\x7F]+", " ", text)


_DATE_RE = re.compile(r"(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})(?!\d)")
_ISO_RE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")
_OCR_DIGITS = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "|": "1", "S": "5", "B": "8"})


def parse_date(text: str) -> str | None:
    """First valid calendar date in `text` as ISO (YYYY-MM-DD), or None."""
    for source in (text, _fix_digit_confusions(text)):
        candidates = [(m.group(3), m.group(2), m.group(1)) for m in _DATE_RE.finditer(source)]
        candidates += [(m.group(1), m.group(2), m.group(3)) for m in _ISO_RE.finditer(source)]
        for year, month, day in candidates:
            try:
                value = date(int(year), int(month), int(day))
            except ValueError:
                continue
            if 1900 <= value.year <= date.today().year:
                return value.isoformat()
    return None


def _fix_digit_confusions(text: str) -> str:
    """Only inside date-looking tokens: OCR often reads 0 as O and 1 as l."""
    return re.sub(r"[0-9OolIS|B/.\-]{8,12}", lambda m: m.group(0).translate(_OCR_DIGITS), text)


def line_below(lines: list[Line], index: int) -> Line | None:
    """The nearest line under lines[index] (by vertical position), skipping ones on the same row."""
    anchor = lines[index]
    below = [ln for ln in lines if ln.box[1] >= anchor.box[3] - 4 and ln is not anchor]
    return min(below, key=lambda ln: ln.box[1], default=None)


def line_above(lines: list[Line], index: int) -> Line | None:
    anchor = lines[index]
    above = [ln for ln in lines if ln.box[3] <= anchor.box[1] + 4 and ln is not anchor]
    return max(above, key=lambda ln: ln.box[3], default=None)


def index_of_label(lines: list[Line], label: str, *, exact: bool = True) -> int | None:
    """Index of the line that is (or starts with) the given label, ignoring case, spacing and punctuation."""
    want = squash(label)
    for i, line in enumerate(lines):
        got = squash(line.text)
        if got == want or (not exact and got.startswith(want)):
            return i
    return None


def union_box(boxes: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def mostly_letters(text: str, minimum: int = 3) -> bool:
    letters = sum(c.isalpha() for c in text)
    return letters >= minimum and letters >= 0.7 * max(len(text.replace(" ", "")), 1)
