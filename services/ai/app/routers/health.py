from fastapi import APIRouter, Request, Response

from app.observability import render_metrics
from app.schemas import Health

router = APIRouter()


@router.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness: the process answers. Loads and checks nothing, so a supervisor can call it freely."""
    return {"status": "ok", "service": "ai"}


@router.get("/readyz", response_model=Health, response_model_by_alias=True)
def readyz(request: Request, response: Response) -> Health:
    """Readiness: 200 only once the OCR models are loaded; 503 while they load or after they failed to."""
    state = request.app.state
    engine = getattr(state, "engine", None)
    error = getattr(state, "load_error", None)
    models = engine.status if engine else {"detector": "error" if error else "loading", "en": "pending", "hi": "pending"}
    import cv2
    import paddleocr

    if not engine:
        response.status_code = 503
    return Health(
        status="ok" if engine else ("error" if error else "loading"),
        models=models,
        versions={"paddleocr": paddleocr.__version__, "opencv": cv2.__version__},
    )


@router.get("/metrics")
def metrics() -> Response:
    body, content_type = render_metrics()
    return Response(content=body, media_type=content_type)
