"""Downloads a document from a signed URL, defensively.

The URL comes from a request body, so it is treated as hostile input (SSRF): only configured
origins, only /files/ paths, no redirects, bounded size and time.
"""

from urllib.parse import urlsplit

import httpx

from app.config import Settings


class FetchRejected(Exception):
    """The URL itself is not acceptable (caller error, never retried)."""


class FetchFailed(Exception):
    """The download failed in a way that may succeed later (retryable)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def validate_url(url: str, settings: Settings) -> None:
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    if parts.scheme not in {"http", "https"} or origin not in settings.allowed_origins:
        raise FetchRejected("signedUrl origin is not allowed")
    segments = parts.path.split("/")
    dotty = any(seg in {".", ".."} or "%2e" in seg.lower() or "%2f" in seg.lower() for seg in segments)
    if not parts.path.startswith("/files/") or dotty or parts.username or parts.password or parts.query:
        raise FetchRejected("signedUrl path is not allowed")


def _rewrite(url: str, settings: Settings) -> str:
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    target = settings.origin_rewrites.get(origin)
    return f"{target}{url[len(origin):]}" if target else url


def fetch_document(url: str, bearer: str | None, settings: Settings) -> bytes:
    validate_url(url, settings)  # always validate the URL we were GIVEN, then rewrite per operator config
    url = _rewrite(url, settings)
    headers = {"Accept": "*/*"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    try:
        with httpx.Client(timeout=settings.fetch_timeout_seconds, follow_redirects=False) as client:
            with client.stream("GET", url, headers=headers) as response:
                if response.status_code != 200:
                    raise FetchFailed(f"document fetch returned {response.status_code}", response.status_code)
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > settings.fetch_max_bytes:
                        raise FetchRejected("document is larger than the allowed maximum")
                    chunks.append(chunk)
                return b"".join(chunks)
    except httpx.HTTPError as err:
        raise FetchFailed(f"document fetch failed: {type(err).__name__}") from err
