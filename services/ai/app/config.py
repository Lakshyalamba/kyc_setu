from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_INTERNAL_KEY = "dev-internal-key-change-me-0123456789"


class Settings(BaseSettings):
    """All settings come from `AI_*` environment variables."""

    model_config = SettingsConfigDict(env_prefix="AI_")

    env: str = "development"
    # Error reporting. Unset = Sentry off and silent.
    sentry_dsn: str | None = None
    log_level: str = "INFO"
    # Shared secret the Node worker sends in `X-Internal-Key`. The service can be made to fetch
    # documents, so it must only answer callers that hold this.
    internal_key: str = DEV_INTERNAL_KEY
    # Origins the service may download documents from (SSRF guard). Comma separated.
    fetch_allowed_origins: str = "http://localhost:4000,http://host.docker.internal:4000"
    # Optional `from=to` pairs (comma separated) applied AFTER the origin check, for networks where the
    # public URL isn't reachable from here (e.g. Docker: http://localhost:4000=http://host.docker.internal:4000).
    fetch_origin_rewrites: str = ""
    fetch_max_bytes: int = 6 * 1024 * 1024  # Phase 2 caps uploads at 5 MB; a little slack
    fetch_timeout_seconds: float = 15.0

    # Quality gates (checked before any OCR is attempted).
    min_sharpness: float = 50.0
    min_side_px: int = 400

    # Paddle inference tuning. Threads unset = Paddle's default. The Linux arm64 build of PaddlePaddle segfaults on
    # its default thread setting, so the Dockerfile pins AI_OCR_CPU_THREADS=2 (see services/ai/README.md).
    ocr_cpu_threads: int | None = None
    ocr_enable_mkldnn: bool = False  # oneDNN is off by default: it fails on Linux x86-64 (see app/vision/ocr.py)

    max_pixels: int = 40_000_000
    pdf_render_dpi: int = 200
    # Tests turn this off and inject a fake OCR engine.
    load_models: bool = True

    @property
    def allowed_origins(self) -> set[str]:
        return {o.strip().rstrip("/") for o in self.fetch_allowed_origins.split(",") if o.strip()}

    @property
    def origin_rewrites(self) -> dict[str, str]:
        pairs = (p.split("=", 1) for p in self.fetch_origin_rewrites.split(",") if "=" in p)
        return {a.strip().rstrip("/"): b.strip().rstrip("/") for a, b in pairs}

    @model_validator(mode="after")
    def _no_dev_key_in_production(self) -> "Settings":
        if self.env == "production" and (self.internal_key == DEV_INTERNAL_KEY or len(self.internal_key) < 32):
            raise ValueError("AI_INTERNAL_KEY must be set to a strong secret in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
