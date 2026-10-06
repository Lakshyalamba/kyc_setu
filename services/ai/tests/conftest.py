import json
from pathlib import Path

import pytest

from app.config import Settings
from app.vision.ocr import Line

ROOT = Path(__file__).resolve().parents[3]
SAMPLES = ROOT / "scripts" / "sample-docs"
CONTRACTS = ROOT / "contracts"
GOLDEN = Path(__file__).parent / "golden"


def load_golden(name: str) -> list[Line]:
    return [Line(d["text"], tuple(d["box"]), d["confidence"]) for d in json.loads((GOLDEN / f"{name}.json").read_text())]


def sample_bytes(name: str) -> bytes:
    return (SAMPLES / f"{name}.png").read_bytes()


@pytest.fixture(scope="session")
def expected() -> dict:
    return json.loads((SAMPLES / "expected.json").read_text())


@pytest.fixture
def settings() -> Settings:
    return Settings(load_models=False, internal_key="test-internal-key-0123456789abcdef")


@pytest.fixture(scope="session")
def real_engine():
    """The real PaddleOCR models. Only used by tests marked `ocr`."""
    from app.vision.ocr import PaddleOcrEngine

    return PaddleOcrEngine()


class FakeEngine:
    """Replays canned OCR lines, so API/pipeline tests don't need the models."""

    def __init__(self, lines: list[Line]):
        self.lines = lines
        self.calls: list[bool] = []

    @property
    def status(self) -> dict[str, str]:
        return {"detector": "loaded", "en": "loaded", "hi": "loaded"}

    def read(self, image, *, with_hindi: bool = False) -> list[Line]:  # noqa: ANN001
        self.calls.append(with_hindi)
        return self.lines
