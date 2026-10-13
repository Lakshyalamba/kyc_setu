import json

import structlog
from fastapi.testclient import TestClient

from app.main import app
from app.observability import configure_logging, scrub_event
from tests.test_api import BODY, H, client  # noqa: F401  (the fixture and the request fixtures)


def test_request_id_is_made_echoed_and_kept(client):
    made = client.get("/healthz").headers["x-request-id"]
    assert len(made) == 36
    kept = client.get("/healthz", headers={"x-request-id": "trace-abc.123"})
    assert kept.headers["x-request-id"] == "trace-abc.123"


def test_a_request_id_that_could_forge_a_log_line_is_replaced(client):
    res = client.get("/healthz", headers={"x-request-id": 'a b"c'})
    assert res.headers["x-request-id"] != 'a b"c' and " " not in res.headers["x-request-id"]


def test_access_log_is_one_json_line_with_request_id_and_latency(client, capsys):
    configure_logging("INFO")
    structlog.reset_defaults()
    configure_logging("INFO")
    client.get("/healthz", headers={"x-request-id": "rid-1"})
    lines = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    access = [l for l in lines if l.get("event") == "request" and l.get("path") == "/healthz"]
    assert len(access) == 1
    assert access[0]["request_id"] == "rid-1" and access[0]["status"] == 200
    assert isinstance(access[0]["latency_ms"], float)


def test_extract_logs_carry_the_session_id_and_never_the_signed_url(client, capsys):
    configure_logging("INFO")
    client.post("/extract/pan", json=BODY, headers={**H, "X-Request-Id": "rid-2"})
    out = capsys.readouterr().out
    access = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
    assert all(BODY["signedUrl"] not in l for l in out.splitlines())
    line = next(l for l in access if l.get("request_id") == "rid-2" and l.get("event") == "request")
    assert line["session_id"] == BODY["sessionId"] and line["path"] == "/extract/pan"


def test_metrics_exposes_the_expected_names(client):
    client.post("/extract/pan", json=BODY, headers=H)
    text = client.get("/metrics").text
    for name in ("ai_extractions_total", "ai_extract_latency_seconds", "ai_match_latency_seconds",
                 "ai_http_request_duration_seconds"):
        assert f"# TYPE {name} " in text
    assert 'ai_extractions_total{document_type="PAN",outcome="ok"}' in text
    assert 'route="/extract/pan"' in text


def test_sentry_scrub_drops_bodies_cookies_and_pii_locals():
    event = scrub_event(
        {
            "request": {"data": {"pan": "ABCDE1234F"}, "cookies": {"a": "b"}, "headers": {"x-internal-key": "k", "accept": "x"}},
            "exception": {"values": [{"stacktrace": {"frames": [{"vars": {"full_name": "Asha Rao", "n": 3}}]}}]},
            "extra": {"raw_text": "Name: Asha", "ok": 1},
            "user": {"id": "u"},
        }
    )
    assert "data" not in event["request"] and "cookies" not in event["request"]
    assert event["request"]["headers"] == {"x-internal-key": "[scrubbed]", "accept": "x"}
    assert event["exception"]["values"][0]["stacktrace"]["frames"][0]["vars"] == {"full_name": "[scrubbed]", "n": 3}
    assert event["extra"] == {"raw_text": "[scrubbed]", "ok": 1}
    assert "user" not in event
