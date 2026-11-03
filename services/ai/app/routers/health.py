from fastapi import APIRouter, Request, Response

from app.config import get_settings
from app.observability import render_metrics
from app.schemas import Health

router = APIRouter()


@router.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness: the process answers. Loads and checks nothing, so a supervisor can call it freely."""
    return {"status": "ok", "service": "ai"}


@router.get("/readyz", response_model=Health, response_model_by_alias=True)
def readyz(request: Request, response: Response) -> Health:
    """Readiness: 200 only once the OCR models AND the face models are loaded; 503 while loading or after a failed load."""
    state = request.app.state
    engine = getattr(state, "engine", None)
    ocr_error = getattr(state, "load_error", None)
    face = getattr(state, "face", None)
    face_error = getattr(state, "face_error", None)
    models = dict(engine.status if engine else {"detector": "error" if ocr_error else "loading", "en": "pending", "hi": "pending"})
    models.update({"face-detector": "stub", "face-recognizer": "stub"} if get_settings().face_backend == "stub" else face.status if face else {"face-detector": "error" if face_error else "loading", "face-recognizer": "error" if face_error else "loading"})
    import cv2
    import paddleocr

    versions = {"paddleocr": paddleocr.__version__, "opencv": cv2.__version__}
    if face:
        versions.update(face.versions)

    stub = get_settings().face_backend == "stub"
    ready = engine is not None and (face is not None or stub)
    if not ready:
        response.status_code = 503
    failed = bool(ocr_error or face_error)
    return Health(status="ok" if ready else ("error" if failed else "loading"), models=models, versions=versions)


@router.get("/metrics")
def metrics() -> Response:
    body, content_type = render_metrics()
    return Response(content=body, media_type=content_type)
