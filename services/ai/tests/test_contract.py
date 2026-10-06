"""The JSON samples in /contracts are validated here (pydantic) and in packages/shared (zod)."""

import json

import pytest
from conftest import CONTRACTS, FakeEngine, load_golden, sample_bytes

from app.config import Settings
from app.pipeline import extract
from app.schemas import ExtractResponse

SAMPLES = sorted(p.name for p in CONTRACTS.glob("extract-*.json"))


def test_there_are_samples():
    assert len(SAMPLES) >= 5


@pytest.mark.parametrize("name", SAMPLES)
def test_sample_validates_and_round_trips(name):
    raw = json.loads((CONTRACTS / name).read_text())
    parsed = ExtractResponse.model_validate(raw)
    assert parsed.model_dump(by_alias=True, exclude_none=True) == raw


@pytest.mark.parametrize(("doc_type", "sample", "contract"), [
    ("PAN", "pan", "extract-pan.ok.json"),
    ("AADHAAR_FRONT", "aadhaar-front", "extract-aadhaar-front.ok.json"),
    ("AADHAAR_BACK", "aadhaar-back", "extract-aadhaar-back.ok.json"),
])  # fmt: skip
def test_pipeline_output_has_the_same_shape_as_the_sample(doc_type, sample, contract):
    out = extract(
        document_id="3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13",
        document_type=doc_type,
        data=sample_bytes(sample),
        engine=FakeEngine(load_golden(sample)),
        settings=Settings(load_models=False),
    ).model_dump(by_alias=True, exclude_none=True)
    reference = json.loads((CONTRACTS / contract).read_text())

    def shape(value):  # keys only, recursively
        return {k: shape(v) for k, v in value.items()} if isinstance(value, dict) else None

    assert shape(out) == shape(reference)
    assert out["status"] == "ok"
