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


# ---- faces: mirror of packages/shared/src/schemas/face.ts -------------------------------------------------------------

LivenessOutcome = Literal["PASSED", "FAILED", "INCONCLUSIVE"]
LivenessFailureReason = Literal["FRAMES_TOO_SIMILAR", "NO_FACE_IN_FRAME", "FACE_MOVED_OUT", "QUALITY_TOO_LOW"]
FaceMatchReason = Literal["no_face_in_id", "no_face_in_selfie", "ambiguous_selfie"]


class MotionCheckRequest(CamelModel):
    capture_id: str
    frame_urls: list[str] = Field(min_length=3, max_length=3)
    best_frame_url: str


class MotionCheckMetrics(CamelModel):
    ssim_pairs: list[float]
    mean_ssim: float | None
    box_iou_pairs: list[float]
    faces_per_frame: list[int]
    sharpness: float | None
    brightness: float | None


class MotionCheckResponse(CamelModel):
    capture_id: str
    method: Literal["MOTION_CHECK"]
    result: LivenessOutcome
    failure_reason: LivenessFailureReason | None
    metrics: MotionCheckMetrics
    model_version: str


class FaceMatchRequest(CamelModel):
    selfie_capture_id: str
    selfie_best_url: str
    id_document_id: str
    id_document_url: str


class FaceMatchResponse(CamelModel):
    selfie_capture_id: str
    id_document_id: str
    score: float = Field(ge=0, le=1)
    embedding_version: str
    reason: FaceMatchReason | None
    id_face_crop_png: str | None
    selfie_face_crop_png: str | None
    id_embedding: str | None
    selfie_embedding: str | None
