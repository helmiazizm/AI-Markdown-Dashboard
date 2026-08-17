SHELL := /bin/sh
FIELDBOARD_CONTENT_PATH ?= ./fieldboard_content
FIELDBOARD_SKILL_PATH ?= .claude/skills/fieldboard-author-dashboard
API_HEALTH_URL ?= http://127.0.0.1:$(or $(API_PORT),3000)/api/health

.PHONY: install skills-install dev up down purge setup migrate data-init data-backfill-summaries data-load-fashion-catalog data-load-tlc-yellow content-bootstrap wait-api test typecheck build

install:
	npm install

skills-install:
	@test -f "$(FIELDBOARD_SKILL_PATH)/SKILL.md" || (echo "Missing in-tree skill at $(FIELDBOARD_SKILL_PATH)"; exit 1)
	node "$(FIELDBOARD_SKILL_PATH)/scripts/validate-skill.mjs" "$(FIELDBOARD_SKILL_PATH)"
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" node "$(FIELDBOARD_SKILL_PATH)/scripts/fieldboard-author.mjs" doctor --allow-offline

dev:
	@test -d "$(FIELDBOARD_CONTENT_PATH)/.git" || (echo "Fieldboard content repository is not initialized: $(FIELDBOARD_CONTENT_PATH)"; echo "Run: make setup"; exit 1)
	mkdir -p data/warehouse
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" docker compose up --build

up:
	@test -d "$(FIELDBOARD_CONTENT_PATH)/.git" || (echo "Run make setup first" && exit 1)
	mkdir -p data/warehouse
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" docker compose up -d --build

down:
	docker compose down --remove-orphans

purge:
	docker compose down -v --remove-orphans
	rm -rf data/warehouse data/raw "$(FIELDBOARD_CONTENT_PATH)"

setup:
	@test -f .env || (echo "Missing .env. Copy .env.example to .env first (do not overwrite a filled .env)."; exit 1)
	$(MAKE) install
	mkdir -p data/raw data/warehouse "$(FIELDBOARD_CONTENT_PATH)"
	$(MAKE) skills-install
	$(MAKE) content-bootstrap
	$(MAKE) data-load-fashion-catalog
	$(MAKE) data-load-tlc-yellow
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" docker compose up -d --build
	$(MAKE) wait-api
	$(MAKE) data-init

wait-api:
	@node scripts/wait-for-health.mjs "$(API_HEALTH_URL)"

migrate:
	docker compose run --rm api npm run migrate -w @fieldboard/api

data-init:
	docker compose run --rm api npm run data:init -w @fieldboard/api

data-backfill-summaries:
	docker compose run --rm api npm run data:backfill-summaries -w @fieldboard/api

data-load-fashion-catalog:
	set -a; . ./.env; set +a; WAREHOUSE_DIR="$(abspath data/warehouse)" npm run data:load-fashion-catalog -w @fieldboard/api

data-load-tlc-yellow:
	set -a; . ./.env; set +a; unset TLC_SOURCE_DATABASE_URL; WAREHOUSE_DIR="$(abspath data/warehouse)" npm run data:load-tlc-yellow -w @fieldboard/api

content-bootstrap:
	@mkdir -p "$(FIELDBOARD_CONTENT_PATH)" data/warehouse
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" docker compose up -d postgres minio minio-init
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" docker compose run --build --rm api npm run content:bootstrap -w @fieldboard/api

test:
	npm test

typecheck:
	npm run typecheck

build:
	npm run build
