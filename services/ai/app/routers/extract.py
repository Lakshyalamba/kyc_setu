import time

from fastapi import APIRouter, Depends, HTTPException, Request

from app import fetch as fetching
from app.config import Settings, get_settings
from app.observability import bind_session, extract_latency, extractions_total
from app.pipeline import extract
from app.schemas import ExtractAadhaarRequest, ExtractPanRequest, ExtractResponse
from app.security import require_internal_key
from app.vision.decode import DecodeError

router = APIRouter(prefix="/extract", dependencies=[Depends(require_internal_key)])


def _run(
    request: Request,
    *,
    document_id: str,
    document_type: str,
    signed_url: str,
    settings: Settings,
    session_id: str | None = None,
) -> ExtractResponse:
    if session_id:
        bind_session(request, session_id)
    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        # Models are still loading (or failed to). 503 is retryable on the worker side.
        raise HTTPException(status_code=503, detail="OCR models are not ready")

    started = time.perf_counter()
    try:
        # The worker's short-lived service token, forwarded to the API's file proxy.
        bearer = request.headers.get("x-fetch-authorization", "").removeprefix("Bearer ").strip() or None
        data = fetching.fetch_document(signed_url, bearer, settings)
    except fetching.FetchRejected as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
    except fetching.FetchFailed as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    fetch_ms = round((time.perf_counter() - started) * 1000, 1)

    work_started = time.perf_counter()
    try:
        result = extract(
            document_id=document_id,
            document_type=document_type,  # type: ignore[arg-type]
            data=data,
            engine=engine,
            settings=settings,
            fetch_ms=fetch_ms,
        )
    except DecodeError as err:
        # A document we can't even open will never succeed on retry.
        extractions_total.labels(document_type, "undecodable").inc()
        raise HTTPException(status_code=422, detail=str(err)) from err
    extract_latency.labels(document_type).observe(time.perf_counter() - work_started)
    extractions_total.labels(document_type, "ok").inc()
    return result


@router.post("/pan", response_model=ExtractResponse, response_model_exclude_none=True)
def extract_pan(
    body: ExtractPanRequest, request: Request, settings: Settings = Depends(get_settings)
) -> ExtractResponse:
    return _run(request, document_id=body.document_id, document_type="PAN", signed_url=body.signed_url, settings=settings, session_id=body.session_id)


@router.post("/aadhaar", response_model=ExtractResponse, response_model_exclude_none=True)
def extract_aadhaar(
    body: ExtractAadhaarRequest, request: Request, settings: Settings = Depends(get_settings)
) -> ExtractResponse:
    return _run(
        request,
        document_id=body.document_id,
        document_type=body.document_type,
        signed_url=body.signed_url,
        settings=settings,
        session_id=body.session_id,
    )
