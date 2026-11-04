# services/ai: OCR, field extraction and face checks

A stateless FastAPI service. **Image in, JSON out.** It never reads Postgres and never writes to object
storage: the Node worker (`apps/api`) hands it a short-lived link, the service downloads the document,
runs the pipeline and returns the result. All database writes happen in the worker.

```
POST /extract/pan       { documentId, signedUrl, sessionId }
POST /extract/aadhaar   { documentId, signedUrl, sessionId, documentType: "AADHAAR_FRONT" | "AADHAAR_BACK" }
GET  /healthz           { status: "ok" | "loading" | "error", models: {...}, versions: {...} }
POST /face/liveness     { captureId, frameUrls[3], bestFrameUrl }                      the motion check
POST /face/match        { selfieCaptureId, selfieBestUrl, idDocumentId, idDocumentUrl } score + crops + embeddings
POST /face/config       { score, motionPasses }    only with AI_FACE_BACKEND=stub (404 otherwise)
```

Every route except the probes requires `X-Internal-Key` (shared secret). The worker also sends
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
video, a mask or a deepfake. A passive anti-spoofing model sits behind it: see the next section.

## The face stand-in (`AI_FACE_BACKEND=stub`)

With `AI_FACE_BACKEND=stub` the service loads no face models and answers `/face/liveness` and `/face/match` from the last
`POST /face/config` (default: a clear match that passes). It looks at no pixels, it is refused when `AI_ENV=production`,
and `/face/config` does not exist with the real models. It is there so a browser run can drive the selfie step to each
outcome without a model that would have to be fed real people's faces: `make ai-stub` starts it, and `scripts/e2e-ci.sh`
does too. It says nothing about how SFace behaves; `tests/test_face.py` covers the real models.

## Passive anti-spoofing (PAD) behind the motion check

`POST /face/liveness` now answers with two results on the same pictures: the motion check (unchanged) and a `pad` object from a
passive presentation-attack detector. The API decides which of them counts (`LIVENESS_METHOD`); the service always returns both,
so a "shadow" run can record PAD without acting on it. **It is not certified anti-spoofing** and no label in the product says it
is: the words are "passive anti-spoofing + motion check passed", never a claim that a person was proven live.

| | |
|---|---|
| Model | Two MiniFASNet networks from Minivision's [Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing), commit `b6d5f04ad78778917853b25c778acef6d5626d15` |
| Weights, as published | `2.7_80x80_MiniFASNetV2.pth` (1,849,453 bytes) SHA-256 `a5eb02e1843f19b5386b953cc4c9f011c3f985d0ee2bb9819eea9a142099bec0`; `4_0_0_80x80_MiniFASNetV1SE.pth` (1,856,130 bytes) SHA-256 `84ee1d37d96894d5e82de5a57df044ef80a58be2b218b5ed7cdfd875ec2f5990` |
| Weights, as shipped | `pad_models/2.7_80x80_MiniFASNetV2.onnx` SHA-256 `1cb86b65b7e204950a10a868049e1012c0892f6f908dc93587f29cf3b3794419`; `pad_models/4_0_0_80x80_MiniFASNetV1SE.onnx` SHA-256 `0a4539e34fd8428967614df33657edbc8ffc0404049104a22dc7eb1589f378a9`. Converted once by `scripts/convert_minifasnet.py`, which refuses a `.pth` that does not match the hash above and checks that cv2.dnn and PyTorch agree. Committed (3.7 MB), copied into the image, checked at start-up: no download at build or run time. |
| Stored with each result | `modelWeightsHash`: SHA-256 of the two ONNX hashes joined by `:`, so a score traces to the exact files. Currently `1da2640b2db1566f0d37158a78d1735efbe0234338edad3ebefdcbc7a77278d2`. |
| Code licence | Apache-2.0 (GitHub reports it; the repository carries the licence text). `scripts/vendor/minifasnet_arch.py` is the upstream architecture file, kept for the conversion only. |
| Training data | **Not disclosed by the publisher.** Neither README names a training set; the repository publishes the training scripts and no data. It is not the case that these weights are documented as trained on CelebA-Spoof, and this project does not claim so. Face anti-spoofing sets are often academic-licence only, and Minivision sells a commercial SDK, so whether these weights may be used commercially is a question for them, not answered by the Apache-2.0 on the code. |
| Not used | SCRFD (insightface's pretrained models are non-commercial research use only): faces are found with YuNet. The upstream models were trained with RetinaFace boxes, so the crop differs slightly from theirs; that is one more reason to calibrate the threshold on your own cameras (docs/calibration.md). |

**How it scores.** The best frame is cut around the face box at 2.7x and at 4x, resized to 80x80, and fed as raw 0-255 BGR (no
scaling, as upstream does) to the two networks; each gives a probability of class 1 ("live"). The score is the geometric mean.
Sub-scores are named for the crop (`scale2_7`, `scale4_0`), not for what they supposedly detect: upstream calls both "patches"
and "full face" only loosely. Scores at or above the pass threshold (default 0.5) are `LIVE`, below the fail threshold (default
0.4) `SPOOF`, between them `BORDERLINE` (a person should look). The API sends the thresholds it holds in `packages/shared`, and
the response echoes them. A picture with no usable face is `UNAVAILABLE` with a reason (`NO_FACE`, `AMBIGUOUS_FACES`).

**Time budget.** PAD runs beside the motion check. It took 7 to 18 ms per frame on the author's laptop (CPU). If it takes longer
than `AI_PAD_BUDGET_MS` (default 600) its answer is dropped, the result is `UNAVAILABLE` / `TIMED_OUT`, and the motion check
answers alone: the call degrades and says so.

**What the tests show.** The real networks run on synthetic input only: a cartoon face on a grey card, photographed by script
(`tests/fixtures/pad-attack-grey-card.png`, made by `scripts/make_pad_fixtures.py`), scores 0.0001 and is a `SPOOF`; a grey square
has no face and degrades with a reason. **There is no photograph of a live face in this repository, so no test shows the networks
calling a real person live.** That positive case is tested with stand-in networks that return fixed probabilities, which proves
the arithmetic and says nothing about the model. Measured error rates need a local, uncommitted set of real selfies and real
attacks: `docs/calibration.md`.

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
| MiniFASNet weights (see PAD section)         | Apache-2.0 (code); training data undisclosed | upstream repository licence file       |
| FastAPI / Starlette / Pydantic / httpx      | MIT / BSD-3-Clause / MIT / BSD-3-Clause   | package metadata                         |

PyMuPDF (AGPL) was deliberately avoided. Re-check against `uv.lock` and the model cards before
distributing the container image; the image also contains Debian and Python base-image components under
their own licences.
