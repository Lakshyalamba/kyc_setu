from fastapi import APIRouter

from app.schemas import (
    AadhaarExtraction,
    AadhaarFields,
    ExtractRequest,
    PanExtraction,
    PanFields,
    StrField,
)

router = APIRouter(prefix="/extract")


# STUB: returns the same fixed payload regardless of the document. Real OCR lands in a later phase.
@router.post("/pan", response_model=PanExtraction)
def extract_pan(_req: ExtractRequest) -> PanExtraction:
    return PanExtraction(
        fields=PanFields(
            pan_number=StrField(value="ABCDE1234F", confidence=0.98),
            full_name=StrField(value="RAHUL KUMAR SHARMA", confidence=0.96),
            father_name=StrField(value="SURESH KUMAR SHARMA", confidence=0.93),
            date_of_birth=StrField(value="1990-05-15", confidence=0.97),
        ),
        overall_confidence=0.96,
    )


@router.post("/aadhaar", response_model=AadhaarExtraction)
def extract_aadhaar(_req: ExtractRequest) -> AadhaarExtraction:
    return AadhaarExtraction(
        fields=AadhaarFields(
            aadhaar_last4=StrField(value="4321", confidence=0.99),
            full_name=StrField(value="Rahul Kumar Sharma", confidence=0.95),
            date_of_birth=StrField(value="1990-05-15", confidence=0.96),
            gender=StrField(value="M", confidence=0.99),
            address=StrField(
                value="12 MG Road, Indiranagar, Bengaluru, Karnataka", confidence=0.88
            ),
            pincode=StrField(value="560038", confidence=0.94),
        ),
        overall_confidence=0.94,
    )
