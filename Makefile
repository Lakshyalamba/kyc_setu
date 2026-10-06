.PHONY: up down seed test reset

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
