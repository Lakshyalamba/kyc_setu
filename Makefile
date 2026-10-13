.PHONY: up down seed test reset ai ai-down keys

DEV_KEYS := infra/dev-keys
AUDIT_KEY := $(DEV_KEYS)/audit-export-ed25519.pem

# The development key that signs audit session packets. Generated once, git-ignored, never used in production
# (there the key is provisioned through an HSM or KMS; see docs/retention-policy.md).
keys:
	@mkdir -p $(DEV_KEYS)
	@test -f $(AUDIT_KEY) || { openssl genpkey -algorithm ed25519 -out $(AUDIT_KEY) && chmod 600 $(AUDIT_KEY) && echo "generated $(AUDIT_KEY)"; }

up: keys
	docker compose up -d --wait

down:
	docker compose down

seed:
	pnpm seed --yes

test:
	REQUIRE_INFRA=1 pnpm test

# Wipes all volumes (DB, Redis, MinIO), recreates infra, migrates and seeds.
reset:
	docker compose down -v
	$(MAKE) up
	pnpm db:migrate
	pnpm seed --yes

# The OCR/extraction service in Docker (first build downloads Paddle + the model weights: slow, ~GBs).
ai:
	docker compose --profile ai up -d --build --wait ai

ai-down:
	docker compose --profile ai stop ai
