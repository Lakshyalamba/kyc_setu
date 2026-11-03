# services/ai: OCR and field extraction

A stateless FastAPI service. **Image in, JSON out.** It never reads Postgres and never writes to object
storage: the Node worker (`apps/api`) hands it a short-lived link, the service downloads the document,
runs the pipeline and returns the result. All database writes happen in the worker.

```
POST /extract/pan       { documentId, signedUrl, sessionId }
POST /extract/aadhaar   { documentId, signedUrl, sessionId, documentType: "AADHAAR_FRONT" | "AADHAAR_BACK" }
GET  /healthz           { status: "ok" | "loading" | "error", models: {...}, versions: {...} }
POST /match             (stub, unchanged from Phase 0)
```

Both extract routes require `X-Internal-Key` (shared secret). The worker also sends
`X-Fetch-Authorization: Bearer <token>`, which the service forwards when it downloads `signedUrl`.
The response contract is `packages/shared/src/schemas/extraction.ts` (zod) mirrored by `app/schemas.py`
(pydantic); both are validated against the JSON samples in `/contracts`.

## Pipeline

```
fetch (SSRF-guarded) -> decode (EXIF rotate, PDF page 1) -> quality gates
  -> deskew + grayscale + adaptive threshold -> PaddleOCR (EN; + Devanagari for Aadhaar back)
  -> parser (regex + layout heuristics) -> response
```

| Stage      | Code                                  | Notes                                                                 |
| ---------- | ------------------------------------- | --------------------------------------------------------------------- |
| fetch      | `app/fetch.py`                        | Origin allow-list, `/files/` only, no redirects, size + time caps     |
| decode     | `app/vision/decode.py`                | Pillow (EXIF) / pypdfium2 (PDF)                                       |
| quality    | `app/vision/quality.py`               | Sharpness = Laplacian variance on a 1000 px wide image; gate `< 50` or min side `< 400` -> `low_quality`, **OCR skipped** |
| preprocess | `app/vision/preprocess.py`            | Median tilt of text-line min-area rectangles; deskew within ±15°      |
| OCR        | `app/vision/ocr.py`                   | Models loaded once at startup, not per request                        |
| parsers    | `app/vision/parsers/*`                | Each returns fields + `ok` / `parse_failed` / `wrong_document`        |

**Statuses.** `ok`; `low_quality` (blurry or too small, nothing is read); `parse_failed` (nothing legible,
or required fields missing); `wrong_document` (expected markers absent, e.g. no "INCOME TAX DEPARTMENT" on a PAN).

**Aadhaar numbers.** The structured response only ever contains `XXXX-XXXX-1234`. The full number can only
appear inside `rawText`, which the worker encrypts immediately and the API never returns.

## Running

```bash
make ai                 # Docker (recommended): builds the image once, models are baked in
pnpm dev:ai             # or natively with uv (needs port 8000 free)
pnpm test:ai            # fast tests, no models needed
pnpm test:ai:ocr        # real-OCR tests (needs the model weights, ~35 s)
```

Environment (`AI_*`, see `app/config.py`): `AI_INTERNAL_KEY`, `AI_FETCH_ALLOWED_ORIGINS`,
`AI_FETCH_ORIGIN_REWRITES` (Docker maps `http://localhost:4000` to `host.docker.internal`),
`AI_OCR_CPU_THREADS`, `AI_OCR_ENABLE_MKLDNN`.

## Design decisions worth knowing

- **Mobile detector, explicit recognisers.** PaddleOCR's default *server* detection model needed about 70 s and 7 GB
  per image on an 8 GB CPU-only machine; `PP-OCRv5_mobile_det` takes about 1.5 s with the same results on our
  documents. Passing a detector name makes PaddleOCR ignore `lang`, so the recognition models are named too
  (`en_PP-OCRv5_mobile_rec`, `devanagari_PP-OCRv3_mobile_rec`). No other hyper-parameters were tuned.
- **Linux arm64 (Docker on Apple Silicon).** PaddlePaddle's arm64 build segfaults on its default CPU-thread
  setting. The image pins `AI_OCR_CPU_THREADS=2` and disables oneDNN. `pyproject.toml` lists
  `required-environments` so one lockfile resolves for macOS arm64 and Linux arm64/x86-64 (PaddlePaddle
  3.3.1 on most, 3.2.2 on Linux arm64).
- **OCR input.** The deskewed colour image is OCR'd; the adaptive-threshold image is only a fallback when the
  first pass reads fewer than 5 characters (binarising usually hurts PaddleOCR).
- **One OpenCV.** `paddleocr` pulls in `opencv-contrib-python`; installing a second OpenCV wheel would shadow `cv2`.
- **PDFs** use `pypdfium2`, not PyMuPDF (AGPL).

## Tests

- `tests/test_parsers.py` replays **golden OCR output** (`tests/golden/*.json`, captured from the real
  models by `scripts/capture_golden.py`), so parser tests are fast and need no weights. Re-capture and review
  the diff whenever the models or preprocessing change.
- `tests/test_pipeline_ocr.py` (marker `ocr`) runs the real models on the synthetic cards: happy paths, JPEG
  compression, ±5° tilt, EXIF rotation, blur -> `low_quality`, tiny image, blank page, noise, and five
  wrong-slot combinations -> `wrong_document`.
- `tests/test_api.py` covers auth, the SSRF guard, error mapping and the response shape with a fake engine.
- **The fixtures are synthetic** (`scripts/sample-docs`, every card says "SAMPLE DOCUMENT - NOT REAL") and the
  parsers were developed against them. These tests prove the pipeline works; they do not measure accuracy on
  real scans, which have glare, holograms, creases and many more layouts. Never add real documents here.

## Face models (Phase 4)

Two small ONNX files from the OpenCV Zoo, run through the `cv2` that PaddleOCR already installs (`FaceDetectorYN`,
`FaceRecognizerSF`): no second inference runtime. They are **not committed**. `scripts/download_face_models.py` fetches them,
checks the SHA-256 below and refuses a file that does not match; the Docker build runs it, so the weights are baked into the image.
Locally they go in `services/ai/models/` (git-ignored). Checked on 2026-11-03.

| File                                  | What                                              | Size     | SHA-256 (first 16)    | Licence    | Evidence                                                                                          |
| ------------------------------------- | ------------------------------------------------- | -------- | --------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `face_detection_yunet_2023mar.onnx`   | YuNet: face detector with five landmarks          | 232,589  | `8f2383e4dd3cfbb4`    | MIT        | the OpenCV Zoo directory says "All files in this directory are licensed under MIT License"        |
| `face_recognition_sface_2021dec.onnx` | SFace: 128-d face embedding, aligned 112x112 input | 38,696,353 | `0ba9fbfa01b5270c`  | Apache-2.0 | the OpenCV Zoo directory says "All files in this directory are licensed under Apache 2.0 License" |

**What is not known.** Neither page states what data the models were trained on. For SFace in particular, face-recognition
training sets are often scraped from the web, and their own terms (not the weights' licence) may restrict commercial use. For
anything a bank would deploy, that provenance has to be established first; this repository does not establish it.

**Why not insightface (SCRFD, buffalo_sc, ArcFace).** Its model zoo states that "ALL models are available for non-commercial
research purposes only". AdaFace and facenet-pytorch ship MIT code but no licence for their weights (trained on WebFace and
VGGFace2), which would have to be cleared separately. If a weight card changes licence between the date above and the day you pull it,
update this table; do not ignore it.

**Score convention.** Cosine similarity of two L2-normalised 128-d embeddings, clamped to 0..1 as `max(0, cosine)` (not
rescaled with `(cosine + 1) / 2`). SFace's own published same-person operating point is a cosine of 0.363. The service returns
the score and the evidence; the API's worker decides using `packages/shared/src/face/thresholds.ts`.

**What the tests do and do not show.** The face tests run the real models on the synthetic cartoon avatars. A real detector
finds those, so the plumbing is exercised, but the embedding does not separate cartoons (different avatars score 0.4 to 0.8
against each other), so no test here says anything about telling real people apart. See `docs/calibration.md`.

**Motion check, not liveness.** `POST /face/liveness` compares three frames shot 300 ms apart inside the face box (SSIM) and
checks the face stays in frame. It catches a photograph held still in front of the camera. It does not catch a replayed
video, a mask or a deepfake. Passive liveness models (MiniFASNet and similar) are deliberately out of scope for this phase.

## Licences

Checked on 2026-10-06 against the installed package metadata (`importlib.metadata`) and, for the models,
the `license:` field of each downloaded model card.

| Component                                   | Licence                                   | Source of the claim                      |
| ------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| PaddleOCR `paddleocr` 3.4.1                 | Apache-2.0                                | package metadata                         |
| PaddlePaddle `paddlepaddle` 3.3.1 / 3.2.2   | Apache-2.0                                | package metadata                         |
| PaddleX `paddlex` 3.4.3                     | Apache-2.0                                | package metadata                         |
| `PP-OCRv5_mobile_det`                       | Apache-2.0                                | model card (`license: apache-2.0`)       |
| `en_PP-OCRv5_mobile_rec`                    | Apache-2.0                                | model card                               |
| `devanagari_PP-OCRv3_mobile_rec`            | Apache-2.0                                | model card                               |
| OpenCV `opencv-contrib-python` 4.10.0.84    | Apache-2.0                                | package metadata                         |
| Pillow 12.x                                 | MIT-CMU                                   | package metadata                         |
| pypdfium2 5.x (PDFium)                      | BSD-3-Clause, Apache-2.0 (plus bundled dependency licences) | package metadata |
| NumPy 2.x                                   | BSD-3-Clause (and other permissive licences for bundled code) | package metadata |
| YuNet / SFace weights (see above)            | MIT / Apache-2.0                          | OpenCV Zoo directory READMEs             |
| FastAPI / Starlette / Pydantic / httpx      | MIT / BSD-3-Clause / MIT / BSD-3-Clause   | package metadata                         |

PyMuPDF (AGPL) was deliberately avoided. Re-check against `uv.lock` and the model cards before
distributing the container image; the image also contains Debian and Python base-image components under
their own licences.
