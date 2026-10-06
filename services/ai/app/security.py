import hmac

from fastapi import Depends, Header, HTTPException

from app.config import Settings, get_settings


def require_internal_key(
    x_internal_key: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    """Rejects callers that don't hold the shared secret. Constant-time comparison."""
    supplied = (x_internal_key or "").encode()
    if not hmac.compare_digest(supplied, settings.internal_key.encode()):
        raise HTTPException(status_code=401, detail="invalid internal key")
