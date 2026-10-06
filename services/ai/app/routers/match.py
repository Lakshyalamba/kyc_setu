from difflib import SequenceMatcher

from fastapi import APIRouter

from app.schemas import MatchRequest, MatchResponse

router = APIRouter()


def _normalise(name: str) -> str:
    return " ".join(name.upper().split())


# STUB: deterministic string similarity only (no ML). Same input always gives the same output.
@router.post("/match", response_model=MatchResponse)
def match(req: MatchRequest) -> MatchResponse:
    similarity = SequenceMatcher(
        None, _normalise(req.pan.full_name.value), _normalise(req.aadhaar.full_name.value)
    ).ratio()
    similarity = round(similarity, 4)
    dob_match = req.pan.date_of_birth.value == req.aadhaar.date_of_birth.value

    reasons: list[str] = []
    if similarity < 0.85:
        reasons.append("NAME_SIMILARITY_BELOW_THRESHOLD")
    if not dob_match:
        reasons.append("DOB_MISMATCH")

    if similarity >= 0.85 and dob_match:
        verdict = "MATCH"
    elif similarity >= 0.6 and dob_match:
        verdict = "REVIEW"
    else:
        verdict = "MISMATCH"
    return MatchResponse(
        name_similarity=similarity, dob_match=dob_match, verdict=verdict, reasons=reasons
    )
