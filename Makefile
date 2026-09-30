# Everyday tasks. `make` (or `make help`) lists them.
# Needs GNU make and a POSIX shell (on Windows, Git's sh.exe on PATH is enough).

CONTAINER_ENGINE ?= podman
IMAGE            ?= ghcr.io/gpillon/ai-scanner
TAG              ?= dev
AGENT_IMAGE      ?= localhost/ai-scanner-agent:latest
PORT             ?= 3000
# Set to `fake` to try the UI without Podman: Scans then get a placeholder Report.
RUNNER           ?=

# Environment over .env: set only what was asked for on the command line.
ENV_RUN = $(if $(RUNNER),SCANNER_RUNNER=$(RUNNER) )PORT=$(PORT)

.DEFAULT_GOAL := help
.PHONY: help install dev dev-backend debug-backend dev-ui build build-backend build-ui start typecheck test test-smoke \
        image agent-image images run-image clean

help: ## List the targets
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## --- Setup ---

install: ## Install backend and UI dependencies
	npm ci
	cd ui && npm ci

.env: ## Create .env from .env.example (never overwrites)
	cp -n .env.example .env

## --- Development ---

dev: .env ## Backend (Nest watch, :3000) and UI (Vite, :5173/ui/) together
	@echo "UI:  http://localhost:5173/ui/   API: http://localhost:$(PORT)/api/docs"
	@$(MAKE) --no-print-directory -j 2 dev-backend dev-ui

dev-backend: .env ## Backend only: `nest start --watch`
	$(ENV_RUN) npm run start:dev

debug-backend: .env ## Backend in watch mode with the inspector on :9229
	$(ENV_RUN) npm run start:debug

dev-ui: ## UI only, on Vite with /api proxied to the backend
	cd ui && SCANNER_API_URL=http://localhost:$(PORT) npm run dev

## --- Build and test ---

build: build-backend build-ui ## Build backend (dist/) and UI (ui/dist/)

build-backend:
	npm run build

build-ui:
	cd ui && npm run build

start: .env build ## Run the built app; the UI is at http://localhost:3000/ui/
	$(ENV_RUN) node --env-file=.env dist/main.js

typecheck: ## Typecheck backend, tests and UI
	npm run typecheck
	cd ui && npm run typecheck

test: ## Run the e2e suite (Podman smoke tests stay skipped)
	npm test

test-smoke: ## Run the Podman smoke tests too (needs Podman and the agent image)
	SCANNER_SMOKE=1 npm test

## --- Containers ---

image: ## Build the service image (API + UI), IMAGE:TAG
	$(CONTAINER_ENGINE) build -f Containerfile -t $(IMAGE):$(TAG) .

agent-image: ## Build the agent image the Podman Runner starts per Attempt
	$(CONTAINER_ENGINE) build -t $(AGENT_IMAGE) containers/agent

images: image agent-image ## Build both images

run-image: .env ## Run the service image, data in the ai-scanner-data volume
	$(CONTAINER_ENGINE) run --rm -it --env-file .env $(if $(RUNNER),-e SCANNER_RUNNER=$(RUNNER)) \
		-p $(PORT):3000 -v ai-scanner-data:/data $(IMAGE):$(TAG)

clean: ## Remove build output (not data/)
	rm -rf dist ui/dist
