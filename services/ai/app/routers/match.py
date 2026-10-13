import time
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends
from pydantic import Field

from app.observability import match_latency
from app.schemas import CamelModel
from app.security import require_internal_key

router = APIRouter(dependencies=[Depends(require_internal_key)])


class _Field(CamelModel):
    value: str
    confidence: float = Field(ge=0, le=1)


class _NameAndDob(CamelModel):
    full_name: _Field
    date_of_birth: _Field


class MatchRequest(CamelModel):
    pan: _NameAndDob
    aadhaar: _NameAndDob


class MatchResponse(CamelModel):
    name_similarity: float
    dob_match: bool
    verdict: str
    reasons: list[str]


# STUB (unchanged from Phase 0): deterministic string similarity, no ML. Real matching comes later.
@router.post("/match", response_model=MatchResponse)
def match(req: MatchRequest) -> MatchResponse:
    started = time.perf_counter()
    norm = lambda s: " ".join(s.upper().split())  # noqa: E731
    similarity = round(SequenceMatcher(None, norm(req.pan.full_name.value), norm(req.aadhaar.full_name.value)).ratio(), 4)
    dob_match = req.pan.date_of_birth.value == req.aadhaar.date_of_birth.value
    reasons = (["NAME_SIMILARITY_BELOW_THRESHOLD"] if similarity < 0.85 else []) + ([] if dob_match else ["DOB_MISMATCH"])
    verdict = "MATCH" if similarity >= 0.85 and dob_match else "REVIEW" if similarity >= 0.6 and dob_match else "MISMATCH"
    match_latency.observe(time.perf_counter() - started)
    return MatchResponse(name_similarity=similarity, dob_match=dob_match, verdict=verdict, reasons=reasons)
