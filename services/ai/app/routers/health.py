from fastapi import APIRouter, Request

from app.schemas import Health

router = APIRouter()


@router.get("/healthz", response_model=Health, response_model_by_alias=True)
def healthz(request: Request) -> Health:
    state = request.app.state
    engine = getattr(state, "engine", None)
    error = getattr(state, "load_error", None)
    models = engine.status if engine else {"detector": "error" if error else "loading", "en": "pending", "hi": "pending"}
    import cv2
    import paddleocr

    return Health(
        status="ok" if engine else ("error" if error else "loading"),
        models=models,
        versions={"paddleocr": paddleocr.__version__, "opencv": cv2.__version__},
    )
