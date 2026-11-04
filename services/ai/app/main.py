import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import get_settings
from app.observability import RequestContextMiddleware, configure_logging, get_logger, init_sentry
from app.routers import extract, face, health

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


def _load_face_models(app: FastAPI) -> None:
    try:
        from app.face.models import load_face_models

        settings = get_settings()
        app.state.face = load_face_models(settings.face_model_dir, min_confidence=settings.face_min_confidence)
        log.info("face_models_loaded")
        if settings.pad_enabled:
            from app.face.pad import load_pad_models

            app.state.pad = load_pad_models(settings.pad_model_dir)
            log.info("pad_models_loaded")
    except Exception as err:  # noqa: BLE001 - reported through /readyz
        app.state.face_error = str(err)
        log.exception("face_model_load_failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = getattr(app.state, "engine", None)
    app.state.load_error = None
    app.state.face = getattr(app.state, "face", None)
    app.state.pad = getattr(app.state, "pad", None)
    app.state.face_error = None
    if get_settings().load_models and app.state.face is None and get_settings().face_backend == "models":
        # The face models are small and quick; load them first so the process is useful sooner.
        threading.Thread(target=_load_face_models, args=(app,), daemon=True, name="face-model-loader").start()
    if get_settings().load_models and app.state.engine is None:
        # Load in the background so the process answers /healthz ("loading") immediately.
        threading.Thread(target=_load_models, args=(app,), daemon=True, name="model-loader").start()
    yield


app = FastAPI(title="KYC Setu AI", version="0.1.0", lifespan=lifespan)
app.add_middleware(RequestContextMiddleware)
app.include_router(health.router)
app.include_router(extract.router)
app.include_router(face.router)
