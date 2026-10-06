"""Parser tests. They replay golden OCR output captured from the real models, so they are fast and
need no model files (see scripts/capture_golden.py)."""

import pytest
from conftest import load_golden

from app.vision.ocr import Line
from app.vision.parsers.aadhaar_back import parse_aadhaar_back
from app.vision.parsers.aadhaar_front import mask_aadhaar, parse_aadhaar_front
from app.vision.parsers.common import normalize_name, parse_date
from app.vision.parsers.pan import parse_pan
from app.vision.parsers.verhoeff import verhoeff_valid


def L(text: str, y: int, conf: float = 0.99, x: int = 60) -> Line:
    """A synthetic OCR line at vertical position y."""
    return Line(text, (x, y, x + 10 * len(text), y + 40), conf)


def values(result) -> dict[str, str]:  # noqa: ANN001
    return {k: f.value for k, f in result.fields.items()}


class TestPan:
    def test_extracts_every_field_from_the_sample(self, expected):
        result = parse_pan(load_golden("pan"))
        assert result.status == "ok"
        assert values(result) == expected["pan"]
        assert all(f.confidence >= 0.9 for f in result.fields.values())

    def test_layout_without_a_name_label_falls_back_to_position(self):
        lines = [
            L("INCOME TAX DEPARTMENT", 20), L("ABCDE1234F", 100),
            L("RAHUL KUMAR SHARMA", 200), L("Father's Name", 260), L("SURESH KUMAR SHARMA", 310),
            L("Date of Birth", 400), L("15/05/1990", 450),
        ]  # fmt: skip
        result = parse_pan(lines)
        assert result.status == "ok"
        assert values(result)["name"] == "RAHUL KUMAR SHARMA"
        assert values(result)["fatherName"] == "SURESH KUMAR SHARMA"
        assert result.fields["name"].confidence < 0.99  # heuristic reads are trusted less

    def test_label_and_value_on_one_line(self):
        lines = [L("INCOME TAX DEPARTMENT", 20), L("ABCDE1234F", 100), L("Name RAHUL KUMAR SHARMA", 200), L("15/05/1990", 300)]
        assert values(parse_pan(lines))["name"] == "RAHUL KUMAR SHARMA"

    def test_repairs_common_ocr_confusions_in_the_pan_number(self):
        lines = [L("INCOME TAX DEPARTMENT", 20), L("A8CDE123OF", 100), L("Name", 200), L("RAHUL SHARMA", 250), L("15/05/1990", 400)]
        result = parse_pan(lines)
        assert values(result)["panNumber"] == "ABCDE1230F"
        assert result.fields["panNumber"].confidence < 0.9

    def test_missing_core_fields_is_parse_failed_not_ok(self):
        result = parse_pan([L("INCOME TAX DEPARTMENT", 20), L("Permanent Account Number", 100)])
        assert result.status == "parse_failed"

    @pytest.mark.parametrize("lines", [
        [L("Government of India", 20), L("RAHUL KUMAR SHARMA", 100), L("DOB: 15/05/1990", 160), L("2341 2341 2346", 300)],
        [L("Address:", 20), L("12 MG Road", 80), L("Bengaluru 560038", 140)],
        [L("Some unrelated receipt", 20), L("Total 450.00", 80)],
        [L("ABCDE1234F", 20)],  # PAN-shaped, but none of the card's wording
    ])  # fmt: skip
    def test_other_documents_are_wrong_document(self, lines):
        assert parse_pan(lines).status == "wrong_document"


class TestAadhaarFront:
    def test_extracts_every_field_from_the_sample(self, expected):
        result = parse_aadhaar_front(load_golden("aadhaar-front"))
        assert result.status == "ok"
        assert values(result) == expected["aadhaar-front"]

    def test_the_full_number_is_never_returned(self):
        result = parse_aadhaar_front(load_golden("aadhaar-front"))
        assert "234123412346" not in str(values(result))
        assert values(result)["aadhaarNumber"] == "XXXX-XXXX-2346"

    def test_checksum_failure_lowers_confidence_and_warns(self):
        good = parse_aadhaar_front([L("Government of India", 20), L("Rahul Sharma", 100), L("DOB: 15/05/1990", 160), L("2341 2341 2346", 300)])
        bad = parse_aadhaar_front([L("Government of India", 20), L("Rahul Sharma", 100), L("DOB: 15/05/1990", 160), L("2341 2341 2347", 300)])
        assert good.status == bad.status == "ok"
        assert not good.warnings and bad.warnings == ["AADHAAR_CHECKSUM_FAILED"]
        assert bad.fields["aadhaarNumber"].confidence < good.fields["aadhaarNumber"].confidence

    def test_number_may_be_unspaced(self):
        result = parse_aadhaar_front([L("Government of India", 20), L("Rahul Sharma", 100), L("DOB: 15/05/1990", 160), L("234123412346", 300)])
        assert values(result)["aadhaarNumber"] == "XXXX-XXXX-2346"

    @pytest.mark.parametrize(("text", "gender"), [("FEMALE", "FEMALE"), ("MALE", "MALE"), ("महिला", "FEMALE"), ("TRANSGENDER", "OTHER")])
    def test_gender_keywords_female_is_not_confused_with_male(self, text, gender):
        lines = [L("Government of India", 20), L("Asha Rao", 100), L("DOB: 01/02/1995", 160), L(text, 220), L("2341 2341 2346", 300)]
        assert values(parse_aadhaar_front(lines))["gender"] == gender

    def test_hindi_header_noise_is_not_taken_for_the_name(self):
        lines = [L("Government of India भारत सरकार", 20), L("आधार", 60), L("Rahul Kumar Sharma", 120), L("DOB: 15/05/1990", 200), L("2341 2341 2346", 300)]
        assert values(parse_aadhaar_front(lines))["name"] == "RAHUL KUMAR SHARMA"

    def test_a_pan_card_is_wrong_document(self):
        assert parse_aadhaar_front(load_golden("pan")).status == "wrong_document"

    def test_the_back_of_the_card_is_not_a_front(self):
        # It has an Aadhaar number but no name/DOB, so this is a failed parse rather than a pass.
        assert parse_aadhaar_front(load_golden("aadhaar-back")).status in {"parse_failed", "wrong_document"}


class TestAadhaarBack:
    def test_extracts_address_and_pincode_from_the_sample(self, expected):
        result = parse_aadhaar_back(load_golden("aadhaar-back"))
        assert result.status == "ok"
        assert result.fields["pincode"].value == expected["aadhaar-back"]["pincode"]
        address = result.fields["address"].value
        for part in expected["aadhaar-back"]["addressContains"]:
            assert part in address
        assert "560038" not in address  # the pincode is its own field
        assert "पता" not in address and "SAMPLE" not in address

    def test_address_on_the_marker_line(self):
        lines = [L("Unique Identification Authority of India", 10), L("Address: S/O Ravi Kumar, 5 Park Street", 100), L("Kolkata, West Bengal - 700016", 160), L("2341 2341 2346", 400)]
        result = parse_aadhaar_back(lines)
        assert result.status == "ok"
        assert result.fields["pincode"].value == "700016"
        assert result.fields["address"].value.startswith("S/O Ravi Kumar, 5 Park Street")

    def test_missing_pincode_is_parse_failed(self):
        lines = [L("Address:", 100), L("12 MG Road", 160), L("Bengaluru", 220)]
        assert parse_aadhaar_back(lines).status == "parse_failed"

    @pytest.mark.parametrize("name", ["pan", "aadhaar-front"])
    def test_other_documents_are_wrong_document(self, name):
        assert parse_aadhaar_back(load_golden(name)).status == "wrong_document"


class TestCommon:
    @pytest.mark.parametrize(("raw", "iso"), [
        ("15/05/1990", "1990-05-15"), ("15-05-1990", "1990-05-15"), ("15.05.1990", "1990-05-15"),
        ("5/1/1990", "1990-01-05"), ("1990-05-15", "1990-05-15"), ("DOB: 15/05/1990", "1990-05-15"),
        ("l5/O5/l99O", "1990-05-15"),
        ("31/02/1990", None), ("15/13/1990", None), ("no date here", None), ("15/05/1850", None),
    ])  # fmt: skip
    def test_parse_date(self, raw, iso):
        assert parse_date(raw) == iso

    @pytest.mark.parametrize(("raw", "clean"), [
        ("Mr. Rahul  kumar", "RAHUL KUMAR"), ("SHRI RAHUL SHARMA", "RAHUL SHARMA"), ("  rahul   k. sharma ", "RAHUL K. SHARMA"),
        ("RAHUL 123 SHARMA", "RAHUL SHARMA"), ("Smt. Asha", "ASHA"),
    ])  # fmt: skip
    def test_normalize_name(self, raw, clean):
        assert normalize_name(raw) == clean

    def test_verhoeff_and_masking(self):
        assert verhoeff_valid("234123412346") and not verhoeff_valid("234123412347")
        assert mask_aadhaar("234123412346") == "XXXX-XXXX-2346"
