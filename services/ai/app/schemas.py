"""Pydantic mirrors of packages/shared/src/schemas/ai.ts. Keep the two in sync."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ExtractRequest(CamelModel):
    object_key: str = Field(min_length=1)


class StrField(CamelModel):
    value: str
    confidence: float = Field(ge=0, le=1)


class PanFields(CamelModel):
    pan_number: StrField
    full_name: StrField
    father_name: StrField
    date_of_birth: StrField


class PanExtraction(CamelModel):
    document_type: Literal["PAN"] = "PAN"
    fields: PanFields
    overall_confidence: float = Field(ge=0, le=1)


class AadhaarFields(CamelModel):
    aadhaar_last4: StrField
    full_name: StrField
    date_of_birth: StrField
    gender: StrField
    address: StrField
    pincode: StrField


class AadhaarExtraction(CamelModel):
    document_type: Literal["AADHAAR"] = "AADHAAR"
    fields: AadhaarFields
    overall_confidence: float = Field(ge=0, le=1)


class NameAndDob(CamelModel):
    full_name: StrField
    date_of_birth: StrField


class MatchRequest(CamelModel):
    pan: NameAndDob
    aadhaar: NameAndDob


class MatchResponse(CamelModel):
    name_similarity: float = Field(ge=0, le=1)
    dob_match: bool
    verdict: Literal["MATCH", "REVIEW", "MISMATCH"]
    reasons: list[str]


class Health(CamelModel):
    status: Literal["ok"] = "ok"
    service: Literal["ai"] = "ai"
