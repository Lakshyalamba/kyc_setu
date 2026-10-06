"""Pydantic mirror of packages/shared/src/schemas/extraction.ts (and /contracts/*.json)."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


ExtractionDocumentType = Literal["PAN", "AADHAAR_FRONT", "AADHAAR_BACK"]
ResultStatus = Literal["ok", "low_quality", "parse_failed", "wrong_document"]


class BBox(CamelModel):
    """Normalised (0..1) box on the deskewed image."""

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(ge=0, le=1)
    h: float = Field(ge=0, le=1)


class ExtractedField(CamelModel):
    value: str
    confidence: float = Field(ge=0, le=1)
    bbox: BBox


class ExtractedFields(CamelModel):
    name: ExtractedField | None = None
    father_name: ExtractedField | None = None
    dob: ExtractedField | None = None
    pan_number: ExtractedField | None = None
    aadhaar_number: ExtractedField | None = None  # always masked: XXXX-XXXX-1234
    gender: ExtractedField | None = None
    address: ExtractedField | None = None
    pincode: ExtractedField | None = None


class Resolution(CamelModel):
    w: int
    h: int


class Quality(CamelModel):
    sharpness: float
    brightness: float
    resolution: Resolution
    deskew_angle: float
    warnings: list[str]


class ModelVersions(CamelModel):
    ocr: str
    ocr_models: str
    preprocessor: str


class Timings(CamelModel):
    fetch_ms: float
    preprocess_ms: float
    ocr_ms: float
    parse_ms: float
    total_ms: float


class ExtractResponse(CamelModel):
    document_id: str
    document_type: ExtractionDocumentType
    status: ResultStatus
    quality: Quality
    fields: ExtractedFields
    raw_text: str
    model_versions: ModelVersions
    timings: Timings


class ExtractPanRequest(CamelModel):
    document_id: str
    signed_url: str
    session_id: str


class ExtractAadhaarRequest(ExtractPanRequest):
    document_type: Literal["AADHAAR_FRONT", "AADHAAR_BACK"]


class Health(CamelModel):
    status: Literal["ok", "loading", "error"]
    service: Literal["ai"] = "ai"
    models: dict[str, str]
    versions: dict[str, str]
