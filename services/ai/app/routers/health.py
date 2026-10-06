from fastapi import APIRouter

from app.schemas import Health

router = APIRouter()


@router.get("/healthz", response_model=Health)
def healthz() -> Health:
    return Health()
