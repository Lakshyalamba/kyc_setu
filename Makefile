.PHONY: up down seed test reset ai ai-down

up:
	docker compose up -d --wait

down:
	docker compose down

seed:
	pnpm seed

test:
	REQUIRE_INFRA=1 pnpm test

# Wipes all volumes (DB, Redis, MinIO), recreates infra, migrates and seeds.
reset:
	docker compose down -v
	$(MAKE) up
	pnpm db:migrate
	pnpm seed

# The OCR/extraction service in Docker (first build downloads Paddle + the model weights: slow, ~GBs).
ai:
	docker compose --profile ai up -d --build --wait ai

ai-down:
	docker compose --profile ai stop ai
