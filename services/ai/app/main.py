import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import get_settings
from app.observability import RequestContextMiddleware, configure_logging, get_logger, init_sentry
from app.routers import extract, health, match

configure_logging(get_settings().log_level)
init_sentry(get_settings().sentry_dsn, get_settings().env)
log = get_logger("startup")


def _load_models(app: FastAPI) -> None:
    try:
        from app.vision.ocr import PaddleOcrEngine

        settings = get_settings()
        engine = PaddleOcrEngine(
            cpu_threads=settings.ocr_cpu_threads, enable_mkldnn=settings.ocr_enable_mkldnn
        )
        # One throw-away read so the first real request doesn't pay the warm-up cost.
        import numpy as np

        engine.read(np.full((64, 256, 3), 255, dtype=np.uint8))
        app.state.engine = engine
        log.info("ocr_models_loaded")
    except Exception as err:  # noqa: BLE001 - reported through /healthz
        app.state.load_error = str(err)
        log.exception("ocr_model_load_failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = getattr(app.state, "engine", None)
    app.state.load_error = None
    if get_settings().load_models and app.state.engine is None:
        # Load in the background so the process answers /healthz ("loading") immediately.
        threading.Thread(target=_load_models, args=(app,), daemon=True, name="model-loader").start()
    yield


app = FastAPI(title="KYC Setu AI", version="0.1.0", lifespan=lifespan)
app.add_middleware(RequestContextMiddleware)
app.include_router(health.router)
app.include_router(extract.router)
app.include_router(match.router)
