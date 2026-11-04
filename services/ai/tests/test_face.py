"""The face pipeline against the real YuNet and SFace weights (skipped if they are not downloaded; REQUIRE_FACE_MODELS=1 fails instead).

What these tests can and cannot say: the synthetic cartoon avatars in scripts/sample-docs/avatars are detected by a real face
detector, so they exercise the plumbing (detection, alignment, the motion check, the score convention). They say NOTHING about
whether the model separates real people: different cartoons score high against each other (see docs/calibration.md).
"""

import base64
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.config import Settings
from app.face.liveness import run_motion_check, ssim
from app.face.match import match_faces
from app.face.models import EMBEDDING_VERSION

ROOT = Path(__file__).resolve().parents[3] / "scripts" / "sample-docs"
SETTINGS = Settings(load_models=False)


def avatar(key: str) -> np.ndarray:
    return cv2.imread(str(ROOT / "avatars" / f"avatar-{key}.png"))


def card(persona: str) -> np.ndarray:
    return cv2.imread(str(ROOT / "personas" / persona / "aadhaar-front.png"))


def shifted(image: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """The same picture a few pixels over, as a head that moved slightly between shots."""
    m = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(image, m, (image.shape[1], image.shape[0]), borderMode=cv2.BORDER_REPLICATE)


def noisy(image: np.ndarray, seed: int) -> np.ndarray:
    """Sensor noise and a slight brightness drift: what two real consecutive frames always have."""
    rng = np.random.default_rng(seed)
    out = image.astype(np.int16) + rng.integers(-18, 19, image.shape) + (seed * 3 - 3)
    return np.clip(out, 0, 255).astype(np.uint8)


# ---- the motion check -------------------------------------------------------------------------------------------------


def test_ssim_of_a_picture_with_itself_is_one_and_of_different_pictures_is_lower():
    gray = cv2.cvtColor(avatar("a"), cv2.COLOR_BGR2GRAY)
    assert ssim(gray, gray) == pytest.approx(1.0, abs=1e-6)
    assert ssim(gray, np.roll(gray, 9, axis=1)) < 0.95


def test_three_identical_frames_fail_as_a_photo_of_a_photo(face_models):
    frame = avatar("a")
    out = run_motion_check(face_models, [frame, frame, frame], frame, SETTINGS)
    assert out["result"] == "FAILED" and out["failureReason"] == "FRAMES_TOO_SIMILAR"
    assert out["metrics"]["meanSsim"] > 0.98
    assert out["method"] == "MOTION_CHECK"


def test_frames_with_no_face_in_them_fail(face_models):
    blank = np.full((440, 360, 3), 200, dtype=np.uint8)
    out = run_motion_check(face_models, [blank, blank, blank], avatar("a"), SETTINGS)
    assert out["result"] == "FAILED" and out["failureReason"] == "NO_FACE_IN_FRAME"
    assert out["metrics"]["facesPerFrame"] == [0, 0, 0]


def test_one_frame_without_a_face_is_enough_to_fail(face_models):
    a = avatar("a")
    blank = np.full_like(a, 200)
    out = run_motion_check(face_models, [a, blank, a], a, SETTINGS)
    assert out["failureReason"] == "NO_FACE_IN_FRAME" and out["metrics"]["facesPerFrame"] == [1, 0, 1]


def test_a_face_that_leaves_and_comes_back_fails(face_models):
    a = avatar("a")
    out = run_motion_check(face_models, [a, shifted(a, 150, 0), a], a, SETTINGS)
    # Either the detector loses it, or the boxes no longer overlap: both are the face leaving the frame.
    assert out["result"] == "FAILED" and out["failureReason"] in {"FACE_MOVED_OUT", "NO_FACE_IN_FRAME"}


def test_a_head_that_moves_a_little_between_frames_passes(face_models):
    a = avatar("a")
    frames = [noisy(shifted(a, -4, 0), 1), noisy(shifted(a, 0, 2), 2), noisy(shifted(a, 4, -2), 3)]
    out = run_motion_check(face_models, frames, frames[1], SETTINGS)
    assert out["metrics"]["meanSsim"] < 0.98, out["metrics"]
    assert out["result"] == "PASSED", out
    assert out["failureReason"] is None


def test_a_dark_best_frame_is_inconclusive_not_failed(face_models):
    a = avatar("a")
    frames = [noisy(shifted(a, -4, 0), 1), noisy(shifted(a, 0, 2), 2), noisy(shifted(a, 4, -2), 3)]
    dark = (frames[1] * 0.1).astype(np.uint8)
    out = run_motion_check(face_models, frames, dark, SETTINGS)
    assert out["result"] == "INCONCLUSIVE" and out["failureReason"] == "QUALITY_TOO_LOW"


# ---- the face match ---------------------------------------------------------------------------------------------------


def test_a_face_matched_with_itself_scores_about_one(face_models):
    out = match_faces(face_models, avatar("a"), avatar("a"), SETTINGS)
    assert out["reason"] is None
    assert out["score"] >= 0.99  # the same pixels, so the same embedding: this is the number to expect
    assert out["embeddingVersion"] == EMBEDDING_VERSION


def test_the_crops_are_aligned_112_pixel_pngs_and_the_embeddings_are_unit_vectors(face_models):
    out = match_faces(face_models, card("anita-rao"), avatar("a"), SETTINGS)
    for key in ("idFaceCropPng", "selfieFaceCropPng"):
        crop = cv2.imdecode(np.frombuffer(base64.b64decode(out[key]), np.uint8), cv2.IMREAD_COLOR)
        assert crop.shape[:2] == (112, 112)
    for key in ("idEmbedding", "selfieEmbedding"):
        vec = np.frombuffer(base64.b64decode(out[key]), dtype="<f4")
        assert vec.shape == (128,) and np.linalg.norm(vec) == pytest.approx(1.0, abs=1e-4)


def test_the_score_is_clamped_to_zero_one(face_models):
    out = match_faces(face_models, avatar("a"), avatar("b"), SETTINGS)
    assert 0.0 <= out["score"] <= 1.0


def test_a_card_with_no_face_fails_with_a_reason_and_no_crops(face_models):
    out = match_faces(face_models, np.full((600, 900, 3), 255, np.uint8), avatar("a"), SETTINGS)
    assert out["reason"] == "no_face_in_id" and out["score"] == 0.0
    assert out["idFaceCropPng"] is None and out["idEmbedding"] is None


def test_a_selfie_with_no_face_fails_with_a_reason(face_models):
    out = match_faces(face_models, avatar("a"), np.full((440, 360, 3), 90, np.uint8), SETTINGS)
    assert out["reason"] == "no_face_in_selfie" and out["score"] == 0.0


def test_two_similar_sized_faces_in_a_selfie_are_ambiguous(face_models):
    a = avatar("a")
    two = np.hstack([a, avatar("b")])
    out = match_faces(face_models, avatar("a"), two, SETTINGS)
    assert out["reason"] == "ambiguous_selfie"


# ---- the HTTP endpoints -----------------------------------------------------------------------------------------------

from fastapi.testclient import TestClient  # noqa: E402

from app import fetch as fetching  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.schemas import FaceMatchResponse, MotionCheckResponse  # noqa: E402

KEY = "test-internal-key-0123456789abcdef"
H = {"X-Internal-Key": KEY, "X-Fetch-Authorization": "Bearer svc"}
CAPTURE = "3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13"
DOC = "7b1d3c5e-1111-4222-8333-444455556666"


def png(image: np.ndarray) -> bytes:
    return cv2.imencode(".png", image)[1].tobytes()


@pytest.fixture
def face_client(monkeypatch, face_models):
    app.dependency_overrides[get_settings] = lambda: Settings(load_models=False, internal_key=KEY)
    app.state.face = face_models
    a = avatar("a")
    pictures = {
        "frame0": png(noisy(shifted(a, -4, 0), 1)),
        "frame1": png(noisy(shifted(a, 0, 2), 2)),
        "frame2": png(noisy(shifted(a, 4, -2), 3)),
        "best": png(noisy(shifted(a, 0, 2), 2)),
        "card": png(card("anita-rao")),
    }
    monkeypatch.setattr(fetching, "fetch_document", lambda url, bearer, settings: pictures[url.rsplit("/", 1)[1]])
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def url(name: str) -> str:
    return f"http://localhost:4000/files/{name}"


def test_the_liveness_endpoint_answers_with_the_contract(face_client):
    body = {"captureId": CAPTURE, "frameUrls": [url("frame0"), url("frame1"), url("frame2")], "bestFrameUrl": url("best")}
    res = face_client.post("/face/liveness", json=body, headers=H)
    assert res.status_code == 200
    parsed = MotionCheckResponse.model_validate(res.json())
    assert parsed.method == "MOTION_CHECK" and parsed.result == "PASSED" and parsed.capture_id == CAPTURE


def test_the_match_endpoint_answers_with_the_contract_and_the_evidence(face_client):
    body = {"selfieCaptureId": CAPTURE, "selfieBestUrl": url("best"), "idDocumentId": DOC, "idDocumentUrl": url("card")}
    res = face_client.post("/face/match", json=body, headers=H)
    assert res.status_code == 200
    parsed = FaceMatchResponse.model_validate(res.json())
    assert parsed.reason is None and 0 <= parsed.score <= 1 and parsed.id_face_crop_png and parsed.selfie_embedding
    assert "decision" not in res.json()  # the service returns evidence; the worker decides


def test_the_face_endpoints_need_the_internal_key(face_client):
    assert face_client.post("/face/match", json={}).status_code == 401
    assert face_client.post("/face/liveness", json={}, headers={"X-Internal-Key": "nope"}).status_code == 401


def test_the_face_endpoints_are_503_while_the_models_load(face_client):
    app.state.face = None
    body = {"selfieCaptureId": CAPTURE, "selfieBestUrl": url("best"), "idDocumentId": DOC, "idDocumentUrl": url("card")}
    assert face_client.post("/face/match", json=body, headers=H).status_code == 503


def test_a_liveness_request_must_carry_exactly_three_frames(face_client):
    body = {"captureId": CAPTURE, "frameUrls": [url("frame0")], "bestFrameUrl": url("best")}
    assert face_client.post("/face/liveness", json=body, headers=H).status_code == 422


def test_embeddings_never_reach_the_logs(face_client, capfd):
    body = {"selfieCaptureId": CAPTURE, "selfieBestUrl": url("best"), "idDocumentId": DOC, "idDocumentUrl": url("card")}
    res = face_client.post("/face/match", json=body, headers=H)
    out = capfd.readouterr().out
    assert res.json()["selfieEmbedding"] not in out and res.json()["idFaceCropPng"] not in out


# ---- the stub backend (AI_FACE_BACKEND=stub) ------------------------------------------------------------------------------


def _stub_client(monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import Settings, get_settings
    from app.main import app

    monkeypatch.setenv("AI_FACE_BACKEND", "stub")
    monkeypatch.setenv("AI_LOAD_MODELS", "false")
    get_settings.cache_clear()
    app.dependency_overrides[get_settings] = lambda: Settings()
    return TestClient(app), app


def test_stub_backend_answers_from_its_config_and_looks_at_no_pixels(monkeypatch):
    from app.config import DEV_INTERNAL_KEY, get_settings

    client, app = _stub_client(monkeypatch)
    try:
        h = {"x-internal-key": DEV_INTERNAL_KEY}
        cid = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b"
        assert client.post("/face/config", json={"score": 0.2, "motionPasses": False, "padScore": 0.45}, headers=h).status_code == 200
        live = client.post(
            "/face/liveness",
            json={"captureId": cid, "frameUrls": ["http://x/a"] * 3, "bestFrameUrl": "http://x/a"},
            headers=h,
        )
        assert live.json()["result"] == "FAILED" and live.json()["failureReason"] == "FRAMES_TOO_SIMILAR"
        assert live.json()["pad"]["decision"] == "BORDERLINE" and live.json()["pad"]["score"] == 0.45
        match = client.post(
            "/face/match",
            json={"selfieCaptureId": cid, "selfieBestUrl": "http://x/a", "idDocumentId": cid, "idDocumentUrl": "http://x/b"},
            headers=h,
        )
        assert match.json()["score"] == 0.2 and match.json()["idEmbedding"] is None
        assert client.post("/face/config", json={"score": 0.85, "motionPasses": True}, headers=h).status_code == 200
    finally:
        app.dependency_overrides.clear()
        get_settings.cache_clear()


def test_stub_backend_is_refused_in_production(monkeypatch):
    import pytest

    from app.config import Settings

    monkeypatch.setenv("AI_ENV", "production")
    monkeypatch.setenv("AI_INTERNAL_KEY", "x" * 40)
    monkeypatch.setenv("AI_FACE_BACKEND", "stub")
    with pytest.raises(ValueError, match="not allowed in production"):
        Settings()


def test_config_route_does_not_exist_with_the_real_models():
    from fastapi.testclient import TestClient

    from app.config import DEV_INTERNAL_KEY
    from app.main import app

    client = TestClient(app)
    res = client.post("/face/config", json={"score": 0.2, "motionPasses": False}, headers={"x-internal-key": DEV_INTERNAL_KEY})
    assert res.status_code == 404
