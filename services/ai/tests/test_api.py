import pytest
from conftest import FakeEngine, load_golden, sample_bytes
from fastapi.testclient import TestClient

from app import fetch as fetching
from app.config import Settings, get_settings
from app.main import app
from app.schemas import ExtractResponse

KEY = "test-internal-key-0123456789abcdef"
DOC = "3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13"
SESSION = "7b1d3c5e-1111-4222-8333-444455556666"
URL = "http://localhost:4000/files/" + "A" * 75


@pytest.fixture
def client(monkeypatch):
    app.dependency_overrides[get_settings] = lambda: Settings(load_models=False, internal_key=KEY)
    app.state.engine = FakeEngine(load_golden("pan"))
    app.state.load_error = None
    seen: dict = {}

    def fake_fetch(url, bearer, settings):  # noqa: ANN001
        seen.update(url=url, bearer=bearer)
        return seen.get("data") or sample_bytes("pan")

    monkeypatch.setattr(fetching, "fetch_document", fake_fetch)
    with TestClient(app) as c:
        c.seen = seen  # type: ignore[attr-defined]
        yield c
    app.dependency_overrides.clear()


H = {"X-Internal-Key": KEY}
BODY = {"documentId": DOC, "signedUrl": URL, "sessionId": SESSION}


def test_healthz_is_liveness_and_needs_no_models(client):
    app.state.engine = None
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "ai"}


def test_readyz_reports_model_status(client):
    res = client.get("/readyz")
    body = res.json()
    assert res.status_code == 200
    assert body["status"] == "ok" and body["service"] == "ai"
    assert body["models"] == {"detector": "loaded", "en": "loaded", "hi": "loaded"}
    assert {"paddleocr", "opencv"} <= set(body["versions"])


def test_readyz_is_503_until_the_models_are_ready(client):
    app.state.engine = None
    res = client.get("/readyz")
    body = res.json()
    assert res.status_code == 503
    assert body["status"] == "loading" and body["models"]["en"] == "pending"


def test_readyz_is_503_and_says_error_when_loading_failed(client):
    app.state.engine = None
    app.state.load_error = "weights missing"
    res = client.get("/readyz")
    assert res.status_code == 503 and res.json()["status"] == "error"
    app.state.load_error = None


def test_extract_requires_the_internal_key(client):
    assert client.post("/extract/pan", json=BODY).status_code == 401
    assert client.post("/extract/pan", json=BODY, headers={"X-Internal-Key": "wrong"}).status_code == 401
    assert client.post("/extract/aadhaar", json={**BODY, "documentType": "AADHAAR_FRONT"}).status_code == 401


def test_extract_pan_returns_the_camelcase_contract(client):
    res = client.post("/extract/pan", json=BODY, headers={**H, "X-Fetch-Authorization": "Bearer svc-token"})
    assert res.status_code == 200
    body = res.json()
    ExtractResponse.model_validate(body)  # validates against the pydantic contract
    assert body["documentId"] == DOC and body["documentType"] == "PAN" and body["status"] == "ok"
    assert body["fields"]["panNumber"]["value"] == "ABCDE1234F"
    assert set(body["fields"]["name"]) == {"value", "confidence", "bbox"}
    assert set(body["timings"]) == {"fetchMs", "preprocessMs", "ocrMs", "parseMs", "totalMs"}
    assert {"sharpness", "brightness", "resolution", "deskewAngle", "warnings"} <= set(body["quality"])
    assert "fatherName" in body["fields"] and "aadhaarNumber" not in body["fields"]  # absent fields are omitted
    # The worker's service token is forwarded to the document URL, and nowhere else.
    assert client.seen["bearer"] == "svc-token" and client.seen["url"] == URL
    assert "svc-token" not in res.text


def test_extract_aadhaar_needs_a_side_and_masks_the_number(client):
    app.state.engine = FakeEngine(load_golden("aadhaar-front"))
    client.seen["data"] = sample_bytes("aadhaar-front")
    assert client.post("/extract/aadhaar", json=BODY, headers=H).status_code == 422
    assert client.post("/extract/aadhaar", json={**BODY, "documentType": "PAN"}, headers=H).status_code == 422
    res = client.post("/extract/aadhaar", json={**BODY, "documentType": "AADHAAR_FRONT"}, headers=H)
    assert res.status_code == 200
    assert res.json()["fields"]["aadhaarNumber"]["value"] == "XXXX-XXXX-2346"


def test_the_back_side_also_reads_hindi(client):
    engine = FakeEngine(load_golden("aadhaar-back"))
    app.state.engine = engine
    client.seen["data"] = sample_bytes("aadhaar-back")
    res = client.post("/extract/aadhaar", json={**BODY, "documentType": "AADHAAR_BACK"}, headers=H)
    assert res.json()["status"] == "ok" and engine.calls == [True]
    assert "पताः" in res.json()["rawText"]


def test_returns_503_while_models_load(client):
    app.state.engine = None
    assert client.post("/extract/pan", json=BODY, headers=H).status_code == 503


def test_an_unreadable_file_is_a_422_not_a_retryable_error(client):
    client.seen["data"] = b"definitely not an image"
    assert client.post("/extract/pan", json=BODY, headers=H).status_code == 422


def test_fetch_problems_map_to_422_and_502(client, monkeypatch):
    def rejected(*_a):
        raise fetching.FetchRejected("signedUrl origin is not allowed")

    def failed(*_a):
        raise fetching.FetchFailed("document fetch returned 410", 410)

    monkeypatch.setattr(fetching, "fetch_document", rejected)
    assert client.post("/extract/pan", json=BODY, headers=H).status_code == 422
    monkeypatch.setattr(fetching, "fetch_document", failed)
    assert client.post("/extract/pan", json=BODY, headers=H).status_code == 502


class TestSsrfGuard:
    settings = Settings(load_models=False, fetch_allowed_origins="http://localhost:4000,http://host.docker.internal:4000")

    @pytest.mark.parametrize("url", [
        "http://localhost:4000/files/abc",
        "http://host.docker.internal:4000/files/abc",
    ])  # fmt: skip
    def test_allowed(self, url):
        fetching.validate_url(url, self.settings)

    @pytest.mark.parametrize("url", [
        "http://evil.example.com/files/abc",
        "http://localhost:4001/files/abc",
        "https://localhost:4000/files/abc",
        "http://localhost:4000/kyc/documents",
        "http://localhost:4000/files/../auth/me",
        "http://localhost:4000/files/%2e%2e/auth/me",
        "http://localhost:4000/files/abc?x=1",
        "http://user:pw@localhost:4000/files/abc",
        "http://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
        "ftp://localhost:4000/files/abc",
    ])  # fmt: skip
    def test_rejected(self, url):
        with pytest.raises(fetching.FetchRejected):
            fetching.validate_url(url, self.settings)


def test_production_refuses_the_default_internal_key():
    with pytest.raises(ValueError, match="AI_INTERNAL_KEY"):
        Settings(env="production")


def test_origin_rewrites_are_operator_config_applied_after_validation():
    from app.fetch import _rewrite

    cfg = Settings(load_models=False, fetch_origin_rewrites="http://localhost:4000=http://host.docker.internal:4000")
    assert _rewrite("http://localhost:4000/files/abc", cfg) == "http://host.docker.internal:4000/files/abc"
    assert _rewrite("http://other:4000/files/abc", cfg) == "http://other:4000/files/abc"
