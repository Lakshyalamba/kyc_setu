#!/usr/bin/env bash
# `pnpm test:e2e:ci`: the whole browser suite against a freshly built local stack, headless, with video.
#
#   docker compose (Postgres, Redis, MinIO, the OCR service) -> migrate -> pnpm seed --yes -> Playwright
#
# Everything it records (videos of the three journeys and of every other spec, traces of failures, the HTML report and
# the run's log) lands in test-artifacts/, which is git-ignored. The exit status is Playwright's.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf test-artifacts
mkdir -p test-artifacts

echo "==> starting the stack"
make up
docker compose --profile ai up -d --build --wait ai

echo "==> building the libraries, migrating and seeding"
pnpm build:libs
pnpm --filter @kyc-setu/db run migrate:deploy
pnpm seed --yes

echo "==> running Playwright (headless, video on)"
status=0
CI=1 E2E_VIDEO=on E2E_REQUIRE_AI=1 pnpm --filter @kyc-setu/web exec playwright test 2>&1 | tee test-artifacts/e2e.log || status=$?
status=${PIPESTATUS[0]:-$status}

echo "==> artifacts in test-artifacts/"
find test-artifacts -name '*.webm' | sort | sed 's/^/    /'
exit "$status"
