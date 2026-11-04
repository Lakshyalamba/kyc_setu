"""Passive anti-spoofing: the real networks on synthetic inputs, plus the plumbing around them.

There is no photograph of a live face in this repository (on purpose), so no test here can show that the networks call a real
person live. What they can show: the pipeline runs end to end, a printed-card attack picture is called a spoof with specific
sub-scores, a picture with no face degrades with a reason, and the decision rules, hashes and time budget behave.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import fetch as fetching
from app.config import Settings, get_settings
from app.face import pad as padmod
from app.main import app
from app.schemas import MotionCheckResponse

FIXTURES = Path(__file__).parent / "fixtures"
KEY = "test-internal-key-0123456789abcdef"
H = {"X-Internal-Key": KEY, "X-Fetch-Authorization": "Bearer svc"}
CAPTURE = "3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13"


@pytest.fixture(scope="session")
def pad_models():
    folder = Path(__file__).resolve().parents[1] / "pad_models"
    return padmod.load_pad_models(os.environ.get("AI_PAD_MODEL_DIR", folder))


def attack() -> np.ndarray:
    return cv2.imread(str(FIXTURES / "pad-attack-grey-card.png"))


def test_a_printed_card_attack_is_a_spoof_with_specific_sub_scores(face_models, pad_models):
    out = padmod.run_passive_pad(face_models, pad_models, attack(), pass_threshold=0.5, fail_threshold=0.4)
    assert out["decision"] == "SPOOF" and out["reason"] is None
    assert set(out["subScores"]) == {"scale2_7", "scale4_0"}
    assert out["score"] < 0.4 and all(0 <= v <= 1 for v in out["subScores"].values())
    # The score is the geometric mean of the two sub-scores.
    assert out["score"] == pytest.approx(np.sqrt(np.prod(list(out["subScores"].values()))), abs=1e-3)
    assert out["modelWeightsHash"] == pad_models.weights_hash and len(out["modelWeightsHash"]) == 64
    assert out["latencyMs"] < 600


def test_a_picture_with_no_face_degrades_with_a_reason_instead_of_failing(face_models, pad_models):
    out = padmod.run_passive_pad(face_models, pad_models, np.full((480, 640, 3), 128, np.uint8), pass_threshold=0.5, fail_threshold=0.4)
    assert out["decision"] == "UNAVAILABLE" and out["reason"] == "NO_FACE" and out["score"] is None and out["subScores"] == {}


def test_the_decision_has_three_bands():
    assert padmod.decide(0.5, 0.5, 0.4) == "LIVE"
    assert padmod.decide(0.4999, 0.5, 0.4) == "BORDERLINE"
    assert padmod.decide(0.4, 0.5, 0.4) == "BORDERLINE"
    assert padmod.decide(0.3999, 0.5, 0.4) == "SPOOF"


def test_the_crop_is_80x80_stays_inside_the_picture_and_handles_a_face_at_the_edge():
    img = np.arange(480 * 640 * 3, dtype=np.uint32).astype(np.uint8).reshape(480, 640, 3)
    for scale in (2.7, 4.0):
        for box in ((250, 150, 120, 150), (0, 0, 100, 100), (540, 380, 100, 100)):
            assert padmod.crop_for_scale(img, box, scale).shape == (80, 80, 3)


class FakeNet:
    """Answers with fixed logits: enough to prove the arithmetic around the networks without a live face to feed them."""

    def __init__(self, live: float):
        spoof = (1 - live) / 2
        self.logits = np.log(np.array([[spoof, live, spoof]], dtype=np.float32))

    def setInput(self, _blob):  # noqa: N802 - cv2.dnn's name
        pass

    def forward(self):
        return self.logits


def test_the_score_of_a_live_looking_face_is_the_geometric_mean_and_passes(face_models):
    import threading

    fake = padmod.PadModels(nets=[FakeNet(0.9), FakeNet(0.4)], weights_hash="x" * 64, lock=threading.Lock())
    avatar = cv2.imread(str(Path(__file__).resolve().parents[3] / "scripts/sample-docs/avatars/avatar-a.png"))
    out = padmod.run_passive_pad(face_models, fake, avatar, pass_threshold=0.5, fail_threshold=0.4)
    assert out["subScores"] == {"scale2_7": pytest.approx(0.9, abs=1e-3), "scale4_0": pytest.approx(0.4, abs=1e-3)}
    assert out["score"] == pytest.approx(0.6, abs=1e-3) and out["decision"] == "LIVE"


def test_a_weights_file_that_does_not_match_its_hash_is_refused(tmp_path, pad_models):
    src = Path(__file__).resolve().parents[1] / "pad_models"
    for f in src.glob("*.onnx"):
        (tmp_path / f.name).write_bytes(f.read_bytes())
    victim = next(tmp_path.glob("2.7_*.onnx"))
    victim.write_bytes(victim.read_bytes() + b"\0")
    with pytest.raises(padmod.PadModelError, match="SHA-256"):
        padmod.load_pad_models(tmp_path)
    with pytest.raises(padmod.PadModelError, match="missing"):
        padmod.load_pad_models(tmp_path / "nope")


# ---- through the HTTP route ----------------------------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch, face_models, pad_models):
    settings = Settings(load_models=False, internal_key=KEY)
    app.dependency_overrides[get_settings] = lambda: settings
    app.state.face, app.state.pad = face_models, pad_models
    shots = [cv2.imencode(".png", attack())[1].tobytes()] * 4
    monkeypatch.setattr(fetching, "fetch_document", lambda url, bearer, s: shots[0])
    with TestClient(app) as c:
        yield c, settings
    app.dependency_overrides.clear()
    app.state.pad = None


def liveness(c, **extra):
    body = {"captureId": CAPTURE, "frameUrls": ["http://localhost:4000/files/a"] * 3, "bestFrameUrl": "http://localhost:4000/files/a", **extra}
    res = c.post("/face/liveness", json=body, headers=H)
    assert res.status_code == 200, res.text
    return MotionCheckResponse.model_validate(res.json())


def test_the_route_returns_the_motion_result_and_the_pad_result_together(client):
    c, _ = client
    out = liveness(c, mode="PASSIVE_PLUS_MOTION", padPassThreshold=0.6, padFailThreshold=0.3)
    assert out.method == "MOTION_CHECK" and out.result == "FAILED"  # three identical frames: the motion check says so
    assert out.pad is not None and out.pad.decision == "SPOOF"
    assert (out.pad.pass_threshold, out.pad.fail_threshold) == (0.6, 0.3)  # the API's thresholds, echoed
    metrics = c.get("/metrics").text
    assert 'liveness_pad_decisions_total{method="PASSIVE_PLUS_MOTION",outcome="spoof"}' in metrics
    assert "liveness_pad_latency_ms_count" in metrics


def test_a_pad_that_runs_over_its_budget_is_dropped_and_the_motion_check_still_answers(client, monkeypatch):
    c, settings = client
    settings.pad_budget_ms = 50
    real = padmod.run_passive_pad

    def slow(*a, **k):
        time.sleep(0.4)
        return real(*a, **k)

    monkeypatch.setattr("app.routers.face.run_passive_pad", slow)
    out = liveness(c)
    assert out.result == "FAILED" and out.pad is not None
    assert out.pad.decision == "UNAVAILABLE" and out.pad.reason == "TIMED_OUT" and out.pad.score is None


def test_a_pad_that_crashes_does_not_take_the_motion_check_with_it(client, monkeypatch):
    c, _ = client

    def boom(*a, **k):
        raise RuntimeError("model fell over")

    monkeypatch.setattr("app.routers.face.run_passive_pad", boom)
    out = liveness(c)
    assert out.result == "FAILED" and out.pad.decision == "UNAVAILABLE" and out.pad.reason == "ERROR"


def test_pad_can_be_switched_off(client):
    c, settings = client
    settings.pad_enabled = False
    out = liveness(c)
    assert out.pad.decision == "UNAVAILABLE" and out.pad.reason == "DISABLED"


def test_readiness_waits_for_the_pad_models(client):
    c, _ = client
    app.state.engine = type("E", (), {"status": {"detector": "loaded"}})()
    try:
        assert c.get("/readyz").status_code == 200
        app.state.pad = None
        assert c.get("/readyz").status_code == 503
    finally:
        app.state.engine = None
