"""PAN card parser: regex for the number and the date, label/layout heuristics for the names."""

from __future__ import annotations

import re

from app.vision.ocr import Line
from app.vision.parsers.common import (
    FieldResult,
    ParseResult,
    has_marker,
    index_of_label,
    line_above,
    line_below,
    mostly_letters,
    normalize_name,
    parse_date,
    squash,
)

PAN_RE = re.compile(r"[A-Z]{5}[0-9]{4}[A-Z]")
# Common OCR confusions, applied position by position to a 10-character candidate.
_TO_LETTER = str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G"})
_TO_DIGIT = str.maketrans({"O": "0", "I": "1", "L": "1", "S": "5", "B": "8", "Z": "2", "G": "6", "D": "0"})
_MARKERS = ("INCOME TAX DEPARTMENT", "INCOME TAX", "PERMANENT ACCOUNT NUMBER", "PERMANENT ACCOUNT")
# Lines that are never a person's name on a PAN card.
_NOT_A_NAME = ("incometax", "govt", "government", "permanentaccount", "signature", "sample", "department")


def _fix_pan(token: str) -> str | None:
    token = re.sub(r"[^A-Za-z0-9]", "", token).upper()
    if len(token) != 10:
        return None
    fixed = token[:5].translate(_TO_LETTER) + token[5:9].translate(_TO_DIGIT) + token[9].translate(_TO_LETTER)
    return fixed if PAN_RE.fullmatch(fixed) else None


def _find_pan(lines: list[Line]) -> FieldResult | None:
    for line in lines:
        compact = re.sub(r"\s+", "", line.text.upper())
        match = PAN_RE.search(compact)
        if match:
            return FieldResult(match.group(0), line.confidence, line.box)
    for line in lines:  # nothing matched exactly: repair a 10-character token
        for token in re.findall(r"[A-Za-z0-9]{10}", re.sub(r"\s+", "", line.text)):
            fixed = _fix_pan(token)
            if fixed:
                return FieldResult(fixed, line.confidence * 0.85, line.box)
    return None


def _value_after_label(lines: list[Line], label: str) -> tuple[Line, float] | None:
    """The value printed under (or beside) a label such as 'Name' or "Father's Name"."""
    i = index_of_label(lines, label)
    if i is not None:
        below = line_below(lines, i)
        return (below, 1.0) if below else None
    i = index_of_label(lines, label, exact=False)  # 'Name RAHUL KUMAR' on a single line
    if i is not None:
        remainder = re.sub(rf"^.*?{re.escape(label)}\W*", "", lines[i].text, count=1, flags=re.IGNORECASE)
        if len(remainder) >= 3:
            return Line(remainder, lines[i].box, lines[i].confidence), 0.9
    return None


def _as_name(candidate: tuple[Line, float] | None) -> FieldResult | None:
    if not candidate:
        return None
    line, certainty = candidate
    if not mostly_letters(line.text) or any(m in squash(line.text) for m in _NOT_A_NAME):
        return None
    name = normalize_name(line.text)
    return FieldResult(name, round(line.confidence * certainty, 4), line.box) if len(name) >= 3 else None


def parse_pan(lines: list[Line]) -> ParseResult:
    pan = _find_pan(lines)
    if not has_marker(lines, *_MARKERS):
        # A PAN-shaped string without any PAN-card wording is not enough to call this a PAN card.
        return ParseResult("wrong_document")

    fields: dict[str, FieldResult] = {}
    if pan:
        fields["panNumber"] = pan

    name = _as_name(_value_after_label(lines, "Name"))
    father = _as_name(_value_after_label(lines, "Father's Name"))
    dob_label = index_of_label(lines, "Date of Birth")

    # Fallbacks: the name sits above the father's label; the father sits above the date label.
    if not name:
        i = index_of_label(lines, "Father's Name")
        above = line_above(lines, i) if i is not None else None
        if above and squash(above.text) != "name":
            name = _as_name((above, 0.8))
    if not father and dob_label is not None:
        above = line_above(lines, dob_label)
        if above:
            father = _as_name((above, 0.8))
    if name:
        fields["name"] = name
    if father:
        fields["fatherName"] = father

    dob_source = None
    if dob_label is not None:
        below = line_below(lines, dob_label)
        dob_source = below if below and parse_date(below.text) else None
    if dob_source is None:
        dob_source = next((ln for ln in lines if parse_date(ln.text)), None)
    if dob_source:
        iso = parse_date(dob_source.text)
        if iso:
            fields["dob"] = FieldResult(iso, dob_source.confidence, dob_source.box)

    complete = all(k in fields for k in ("panNumber", "name", "dob"))
    return ParseResult("ok" if complete else "parse_failed", fields)
