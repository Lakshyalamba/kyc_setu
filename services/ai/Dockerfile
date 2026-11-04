FROM python:3.11-slim AS base

# OpenCV and Paddle need these shared libraries even for headless use.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    # Model weights live here (baked in below), not in a home directory.
    PADDLE_PDX_CACHE_HOME=/opt/paddlex \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    AI_FACE_MODEL_DIR=/opt/face-models \
    AI_PAD_MODEL_DIR=/app/pad_models \
    PYTHONUNBUFFERED=1 \
    # PaddlePaddle's Linux arm64 build segfaults on its default CPU-thread setting; an explicit small
    # count works (measured 2-3 s per document). oneDNN is not used on arm64.
    AI_OCR_CPU_THREADS=2 \
    AI_OCR_ENABLE_MKLDNN=false

COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

FROM base AS runtime
COPY app ./app
# The anti-spoofing networks (ONNX, 1.8 MB each) are in the repository, so the build needs no network for them; they are checked
# against a known SHA-256 when the service starts.
COPY pad_models ./pad_models
COPY scripts/download_models.py scripts/download_face_models.py ./scripts/
# Pre-download the OCR models at build time (PaddleOCR would otherwise fetch them on first use).
RUN PYTHONPATH=/app python scripts/download_models.py
# The face weights too (checked against a known SHA-256), into the image.
RUN PYTHONPATH=/app AI_FACE_MODEL_DIR=/opt/face-models python scripts/download_face_models.py

RUN useradd --system --uid 10001 app && chown -R app /app /opt/paddlex /opt/face-models
USER app
EXPOSE 8000
# Ready only once the models are loaded (the first minute is "loading").
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=12 \
    CMD curl -sf http://localhost:8000/readyz | grep -q '"status":"ok"' || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
