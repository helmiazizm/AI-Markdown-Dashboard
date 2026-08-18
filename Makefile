SHELL := /bin/sh
FIELDBOARD_CONTENT_PATH ?= ./fieldboard_content
FIELDBOARD_SKILL_PATH ?= .claude/skills/fieldboard-author-dashboard
CONTENT_ABS := $(abspath $(FIELDBOARD_CONTENT_PATH))
CONTENT_PARENT := $(patsubst %/,%,$(dir $(CONTENT_ABS)))
CONTENT_NAME := $(notdir $(CONTENT_ABS))
ENV_API_PORT := $(shell sed -n 's/^API_PORT=//p' .env 2>/dev/null | tail -1)
API_HEALTH_URL ?= http://127.0.0.1:$(or $(API_PORT),$(ENV_API_PORT),3000)/api/health

.PHONY: install build-contracts warehouse-idle skills-install dev up down purge setup migrate data-init data-backfill-summaries data-load-fashion-catalog data-load-tlc-yellow content-bootstrap wait-api test typecheck build

install:
	npm install

build-contracts:
	npm run build -w @fieldboard/contracts

skills-install:
	@test -f "$(FIELDBOARD_SKILL_PATH)/SKILL.md" || (echo "Missing in-tree skill at $(FIELDBOARD_SKILL_PATH)"; exit 1)
	node "$(FIELDBOARD_SKILL_PATH)/scripts/validate-skill.mjs" "$(FIELDBOARD_SKILL_PATH)"
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" node "$(FIELDBOARD_SKILL_PATH)/scripts/fieldboard-author.mjs" doctor --allow-offline

dev:
	@git -C "$(FIELDBOARD_CONTENT_PATH)" rev-parse --git-dir >/dev/null 2>&1 || (echo "Fieldboard content repository is not initialized: $(FIELDBOARD_CONTENT_PATH)"; echo "Run: make setup"; exit 1)
	mkdir -p data/warehouse
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" docker compose up --build

up:
	@git -C "$(FIELDBOARD_CONTENT_PATH)" rev-parse --git-dir >/dev/null 2>&1 || (echo "Run make setup first" && exit 1)
	mkdir -p data/warehouse
	FIELDBOARD_CONTENT_PATH="$(abspath $(FIELDBOARD_CONTENT_PATH))" docker compose up -d --build

down:
	docker compose down --remove-orphans

purge:
	docker compose down -v --remove-orphans
	@# Fieldboard commits into the content repository from the api container, which
	@# runs as root, so parts of it are not removable by the host user. Delete them
	@# from a throwaway root container first, then clean up whatever is left.
	-docker run --rm -v "$(abspath .):/purge-repo" -v "$(CONTENT_PARENT):/purge-content" alpine:3 \
	  sh -c 'rm -rf /purge-repo/data/warehouse /purge-repo/data/raw "/purge-content/$(CONTENT_NAME)"'
	rm -rf data/warehouse data/raw "$(FIELDBOARD_CONTENT_PATH)"

setup:
	@test -f .env || (echo "Missing .env. Copy .env.example to .env first (do not overwrite a filled .env)."; exit 1)
	$(MAKE) install
	$(MAKE) build-contracts
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

warehouse-idle:
	@test -z "$$(docker compose ps -q api 2>/dev/null)" || (\
	  echo "The api container is running and holds the DuckDB warehouse files open."; \
	  echo "Host-side loaders would be silently overwritten by its checkpoint."; \
	  echo "Run: docker compose stop api"; exit 1)

data-load-fashion-catalog: warehouse-idle
	set -a; . ./.env; set +a; WAREHOUSE_DIR="$(abspath data/warehouse)" npm run data:load-fashion-catalog -w @fieldboard/api

data-load-tlc-yellow: warehouse-idle
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
