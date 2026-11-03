import time

from fastapi import APIRouter, Depends, HTTPException, Request

from app import fetch as fetching
from app.config import Settings, get_settings
from app.face.liveness import run_motion_check
from app.face.match import match_faces
from app.observability import bind_session, face_latency
from app.schemas import FaceMatchRequest, FaceMatchResponse, MotionCheckMetrics, MotionCheckRequest, MotionCheckResponse
from app.security import require_internal_key
from app.vision.decode import DecodeError, decode_image

router = APIRouter(prefix="/face", dependencies=[Depends(require_internal_key)])


def _models(request: Request):
    models = getattr(request.app.state, "face", None)
    if models is None:
        # Still loading (or failed to): 503 is retryable on the worker side.
        raise HTTPException(status_code=503, detail="face models are not ready")
    return models


def _image(url: str, bearer: str | None, settings: Settings):
    try:
        return decode_image(fetching.fetch_document(url, bearer, settings), max_pixels=settings.max_pixels)
    except fetching.FetchRejected as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
    except fetching.FetchFailed as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    except DecodeError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err


def _bearer(request: Request) -> str | None:
    return request.headers.get("x-fetch-authorization", "").removeprefix("Bearer ").strip() or None


@router.post("/liveness", response_model=MotionCheckResponse, response_model_by_alias=True)
def liveness(
    body: MotionCheckRequest, request: Request, settings: Settings = Depends(get_settings)
) -> MotionCheckResponse:
    """The motion check. Named for what it is: it only notices a picture held still in front of the camera."""
    models = _models(request)
    bearer = _bearer(request)
    started = time.perf_counter()
    frames = [_image(url, bearer, settings) for url in body.frame_urls]
    best = _image(body.best_frame_url, bearer, settings)
    result = run_motion_check(models, frames, best, settings)
    face_latency.labels("motion_check").observe(time.perf_counter() - started)
    return MotionCheckResponse(
        capture_id=body.capture_id,
        method=result["method"],
        result=result["result"],
        failure_reason=result["failureReason"],
        metrics=MotionCheckMetrics.model_validate(result["metrics"]),
        model_version=result["modelVersion"],
    )


@router.post("/match", response_model=FaceMatchResponse, response_model_by_alias=True)
def match(
    body: FaceMatchRequest, request: Request, settings: Settings = Depends(get_settings)
) -> FaceMatchResponse:
    models = _models(request)
    bearer = _bearer(request)
    started = time.perf_counter()
    selfie = _image(body.selfie_best_url, bearer, settings)
    id_image = _image(body.id_document_url, bearer, settings)
    result = match_faces(models, id_image, selfie, settings)
    face_latency.labels("match").observe(time.perf_counter() - started)
    return FaceMatchResponse(
        selfie_capture_id=body.selfie_capture_id,
        id_document_id=body.id_document_id,
        score=result["score"],
        embedding_version=result["embeddingVersion"],
        reason=result["reason"],
        id_face_crop_png=result["idFaceCropPng"],
        selfie_face_crop_png=result["selfieFaceCropPng"],
        id_embedding=result["idEmbedding"],
        selfie_embedding=result["selfieEmbedding"],
    )
