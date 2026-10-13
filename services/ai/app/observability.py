"""Structured logs, request ids, Prometheus metrics and Sentry for the AI service.

Every log line is one JSON object. `request_id` / `session_id` are bound per request (contextvars) so code deep in the
pipeline need not pass them around. Sentry is off unless AI_SENTRY_DSN is set, and scrubs personal data before sending.
"""

from __future__ import annotations

import logging
import re
import sys
import time
import uuid
from typing import Any

import structlog
from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# ---- metrics ---------------------------------------------------------------------------------------------------

registry = CollectorRegistry()

http_duration = Histogram(
    "ai_http_request_duration_seconds",
    "HTTP request latency by route pattern",
    ["method", "route", "status"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
    registry=registry,
)
extractions_total = Counter(
    "ai_extractions_total", "Extraction calls by document type and outcome", ["document_type", "outcome"], registry=registry
)
extract_latency = Histogram(
    "ai_extract_latency_seconds",
    "Time spent extracting one document (OCR and parsing, excluding the fetch)",
    ["document_type"],
    buckets=(0.25, 0.5, 1, 2, 5, 10, 20, 40, 60),
    registry=registry,
)
match_latency = Histogram(
    "ai_match_latency_seconds",
    "Time spent on a /match call. Today this is the name/date-of-birth comparison stub; face matching is not built.",
    buckets=(0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1),
    registry=registry,
)


def render_metrics() -> tuple[bytes, str]:
    return generate_latest(registry), CONTENT_TYPE_LATEST


# ---- logging ---------------------------------------------------------------------------------------------------

_REDACT_KEYS = {"authorization", "x-internal-key", "x-fetch-authorization", "cookie", "password", "signed_url", "signedurl"}


def _redact(_: Any, __: str, event: dict[str, Any]) -> dict[str, Any]:
    for key in list(event):
        if key.lower() in _REDACT_KEYS:
            event[key] = "[redacted]"
    return event


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level.upper(), force=True)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.dict_tracebacks,
            _redact,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(getattr(logging, level.upper(), logging.INFO)),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )


def get_logger(component: str):
    return structlog.get_logger(service="kyc-ai", component=component)


def bind_session(request: Request, session_id: str) -> None:
    """Sync endpoints run in a worker thread with a copy of the context, so what they bind there never reaches the
    middleware that writes the access line. The scope is shared, so the id is left there too."""
    request.scope["kyc_session_id"] = session_id
    structlog.contextvars.bind_contextvars(session_id=session_id)


# ---- request context middleware ----------------------------------------------------------------------------------

_access = None


class RequestContextMiddleware:
    """Takes `x-request-id` from the caller (the Node API forwards it) or makes one, echoes it, and writes one
    access-log line per request with its latency. Pure ASGI so it adds no buffering."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        global _access
        _access = _access or get_logger("http")
        incoming = Request(scope).headers.get("x-request-id", "")
        request_id = incoming if _SAFE_ID.match(incoming) else str(uuid.uuid4())
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)
        started = time.perf_counter()
        status = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message.setdefault("headers", []).append((b"x-request-id", request_id.encode()))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            seconds = time.perf_counter() - started
            route = scope.get("route")
            pattern = getattr(route, "path", None) or "unmatched"
            http_duration.labels(scope["method"], pattern, str(status)).observe(seconds)
            _access.info(
                "request",
                method=scope["method"],
                path=scope["path"],
                status=status,
                latency_ms=round(seconds * 1000, 2),
                **({"session_id": scope["kyc_session_id"]} if "kyc_session_id" in scope else {}),
            )
            structlog.contextvars.clear_contextvars()


# ---- Sentry ----------------------------------------------------------------------------------------------------

PII_KEYS = {
    "pan", "aadhaar", "aadhaar_number", "mobile", "phone", "email", "dob", "date_of_birth", "full_name", "name",
    "address", "raw_text", "text", "lines", "value", "token", "authorization", "cookie", "x-internal-key",
    "x-fetch-authorization", "signed_url", "signedurl", "password",
}


def _scrub(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return value
    if isinstance(value, dict):
        return {k: ("[scrubbed]" if str(k).lower() in PII_KEYS else _scrub(v, depth + 1)) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrub(v, depth + 1) for v in value]
    return value


def scrub_event(event: dict[str, Any], hint: Any = None) -> dict[str, Any]:
    """Runs before every Sentry event: no request bodies, no cookies or key headers, and stack-frame locals, extras and
    contexts scrubbed by key name (document text and extracted values are the things most likely to be in a local)."""
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("data", None)
        request.pop("cookies", None)
        request.pop("query_string", None)
        if "headers" in request:
            request["headers"] = _scrub(request["headers"])
    for exc in (event.get("exception") or {}).get("values", []):
        for frame in (exc.get("stacktrace") or {}).get("frames", []):
            if "vars" in frame:
                frame["vars"] = _scrub(frame["vars"])
    for key in ("extra", "contexts"):
        if key in event:
            event[key] = _scrub(event[key])
    event.pop("user", None)
    return event


def init_sentry(dsn: str | None, environment: str) -> bool:
    if not dsn:
        return False
    import sentry_sdk

    sentry_sdk.init(dsn=dsn, environment=environment, send_default_pii=False, before_send=scrub_event)
    return True
