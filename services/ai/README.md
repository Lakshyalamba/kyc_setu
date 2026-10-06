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
| FastAPI / Starlette / Pydantic / httpx      | MIT / BSD-3-Clause / MIT / BSD-3-Clause   | package metadata                         |

PyMuPDF (AGPL) was deliberately avoided. Re-check against `uv.lock` and the model cards before
distributing the container image; the image also contains Debian and Python base-image components under
their own licences.
