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
    PYTHONUNBUFFERED=1 \
    # PaddlePaddle's Linux arm64 build segfaults on its default CPU-thread setting; an explicit small
    # count works (measured 2-3 s per document). oneDNN is not used on arm64.
    AI_OCR_CPU_THREADS=2 \
    AI_OCR_ENABLE_MKLDNN=false

COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

FROM base AS runtime
COPY app ./app
COPY scripts/download_models.py ./scripts/download_models.py
# Pre-download the OCR models at build time (PaddleOCR would otherwise fetch them on first use).
RUN PYTHONPATH=/app python scripts/download_models.py

RUN useradd --system --uid 10001 app && chown -R app /app /opt/paddlex
USER app
EXPOSE 8000
# Ready only once the models are loaded (the first minute is "loading").
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=12 \
    CMD curl -sf http://localhost:8000/healthz | grep -q '"status":"ok"' || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
