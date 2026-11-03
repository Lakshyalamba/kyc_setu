import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app import fetch as fetching
from app.config import Settings, get_settings
from app.face.liveness import run_motion_check
from app.face.match import match_faces
from app.observability import bind_session, face_latency
from app.schemas import FaceMatchRequest, FaceMatchResponse, MotionCheckMetrics, MotionCheckRequest, MotionCheckResponse
from app.security import require_internal_key
from app.vision.decode import DecodeError, decode_image

router = APIRouter(prefix="/face", dependencies=[Depends(require_internal_key)])

# AI_FACE_BACKEND=stub only: what the stand-in answers next. A process setting for a dev/CI run, not data about anyone.
_stub = {"score": 0.85, "motion_passes": True}


class StubConfig(BaseModel):
    score: float = Field(ge=0, le=1)
    motion_passes: bool = Field(alias="motionPasses")
    model_config = {"populate_by_name": True}


@router.post("/config")
def stub_config(body: StubConfig, settings: Settings = Depends(get_settings)) -> dict[str, bool]:
    if settings.face_backend != "stub":
        raise HTTPException(status_code=404, detail="not available")
    _stub.update(score=body.score, motion_passes=body.motion_passes)
    return {"ok": True}


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
    if settings.face_backend == "stub":
        ok = bool(_stub["motion_passes"])
        return MotionCheckResponse(
            capture_id=body.capture_id,
            method="MOTION_CHECK",
            result="PASSED" if ok else "FAILED",
            failure_reason=None if ok else "FRAMES_TOO_SIMILAR",
            metrics=MotionCheckMetrics(
                ssim_pairs=[0.55, 0.5] if ok else [0.995, 0.996],
                mean_ssim=0.525 if ok else 0.9955,
                box_iou_pairs=[0.93, 0.9],
                faces_per_frame=[1, 1, 1],
                sharpness=50.0,
                brightness=150.0,
            ),
            model_version="stub",
        )
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
    if settings.face_backend == "stub":
        return FaceMatchResponse(
            selfie_capture_id=body.selfie_capture_id,
            id_document_id=body.id_document_id,
            score=float(_stub["score"]),
            embedding_version="stub",
            reason=None,
            id_face_crop_png=None,
            selfie_face_crop_png=None,
            id_embedding=None,
            selfie_embedding=None,
        )
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
