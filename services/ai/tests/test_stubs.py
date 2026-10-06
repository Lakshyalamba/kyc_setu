from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "ai"}


def test_extract_pan_is_deterministic_and_camel_case():
    body = {"objectKey": "pan/1.png"}
    a = client.post("/extract/pan", json=body)
    b = client.post("/extract/pan", json=body)
    assert a.status_code == 200
    assert a.json() == b.json()
    data = a.json()
    assert data["documentType"] == "PAN"
    assert data["fields"]["panNumber"]["value"] == "ABCDE1234F"


def test_extract_aadhaar_only_returns_last4():
    r = client.post("/extract/aadhaar", json={"objectKey": "aadhaar/1.png"})
    assert r.status_code == 200
    assert r.json()["fields"]["aadhaarLast4"]["value"] == "4321"
    assert "aadhaarNumber" not in r.json()["fields"]


def test_extract_rejects_missing_key():
    assert client.post("/extract/pan", json={}).status_code == 422


def _nd(name: str, dob: str) -> dict:
    return {
        "fullName": {"value": name, "confidence": 1},
        "dateOfBirth": {"value": dob, "confidence": 1},
    }


def test_match_verdicts():
    same = client.post(
        "/match",
        json={"pan": _nd("RAHUL KUMAR SHARMA", "1990-05-15"), "aadhaar": _nd("Rahul Kumar Sharma", "1990-05-15")},
    ).json()
    assert same["verdict"] == "MATCH" and same["dobMatch"] is True

    bad = client.post(
        "/match",
        json={"pan": _nd("RAHUL KUMAR SHARMA", "1990-05-15"), "aadhaar": _nd("Priya Singh", "1985-01-01")},
    ).json()
    assert bad["verdict"] == "MISMATCH"
    assert "DOB_MISMATCH" in bad["reasons"]
