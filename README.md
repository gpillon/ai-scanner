# ai-scanner

An HTTP service that receives source code, runs an AI coding agent on it with a chosen analysis, and returns a Report.

A caller uploads a **Source Archive** (a zip) and picks a **Scan Profile**, such as `security`. The server runs [opencode](https://opencode.ai) headless on the code, in an isolated container per Attempt, and retries when an Attempt produces no valid output. It then fills the profile's **Report Template** with the Findings the agent wrote. The caller polls the **Scan** and downloads its **Artifacts**: `report.pdf`, `report.md` and `findings.json`.

It comes with a web UI (PatternFly) and an OpenAPI description of the API. [GLOSSARY.md](GLOSSARY.md) defines the terms used here, and [docs/adr/](docs/adr) records the decisions behind them.

## Quick start

You need Node.js 24 (see `engines` in `package.json` for the minimum), GNU make and a POSIX shell. On Windows, Git's `sh.exe` on `PATH` is enough. Running real Scans also needs Podman.

```sh
make install          # backend and UI dependencies
make dev RUNNER=fake  # creates .env from .env.example on first run
```

- UI (Vite, hot reload): http://localhost:5173/ui/
- API and Swagger UI: http://localhost:3000/api/docs

Sign in with the token from `SCANNER_TOKEN` in `.env`. With `RUNNER=fake`, Scans skip the agent and get a placeholder Report, which is enough to work on the API and the UI. Without it, the Podman Runner needs the agent image: `make agent-image`.

`make` on its own lists every target:

| Target | What it does |
| --- | --- |
| `make dev` | Backend (`nest start --watch`) and UI (Vite) together |
| `make dev-backend` / `make dev-ui` | One of the two |
| `make debug-backend` | Backend in watch mode with the inspector on `:9229` |
| `make build` | `dist/` (backend) and `ui/dist/` (UI) |
| `make start` | Run the build; the UI is served at http://localhost:3000/ui/ |
| `make typecheck` / `make test` | Typecheck everything / run the e2e suite |
| `make test-smoke` | Also run the Podman smoke tests (real containers) |
| `make image` / `make agent-image` | Build the service image / the agent image |
| `make run-image` | Run the service image with `.env`, data in a volume |

`RUNNER`, `PORT`, `CONTAINER_ENGINE` (default `podman`), `IMAGE` and `TAG` can be overridden on the command line, e.g. `make image CONTAINER_ENGINE=docker TAG=test`.

## Using the API

Every `/api` endpoint requires `Authorization: Bearer <SCANNER_TOKEN>` ([ADR-0002](docs/adr/0002-no-user-concept-caller-chosen-scan-id.md)). The caller chooses the Scan id. Anyone with the token and the id can read the Report, so ids should be unguessable.

```sh
TOKEN=change-me; ID=$(uuidgen | tr A-Z a-z)

curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/profiles
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/models

curl -H "Authorization: Bearer $TOKEN" -F file=@code.zip -F profile=security \
     -F language=en -F instructions="Focus on the payment module" \
     localhost:3000/api/scan/$ID

curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/scan/$ID          # queued → running → succeeded | failed
curl -H "Authorization: Bearer $TOKEN" -o report.pdf localhost:3000/api/scan/$ID/artifacts/report.pdf
curl -H "Authorization: Bearer $TOKEN" -X DELETE localhost:3000/api/scan/$ID  # stop and remove
```

The OpenAPI document is at `/api/openapi.json`, and `/api/docs` renders it. Neither requires the token.

## Web UI

The UI lives in [`ui/`](ui): Vite, React, TypeScript and [PatternFly](https://www.patternfly.org). Its pages:

- **Scans**: the Scans this browser started or opened, with their live state. The server deliberately has no endpoint that lists Scans, so other Scans are opened by id.
- **New Scan**: upload a zip and pick a profile, model, language and instructions. The Scan id is a random UUID.
- **Scan**: details, failure reason, Artifact downloads, a Findings table, and delete.
- **Documentation**: the backend's Swagger UI, already signed in with your token.

In production the backend serves the built UI as static files under `/ui/`, and `/` redirects there. The UI is public: it holds no data, and it asks for the token to call the API. If `ui/dist` is missing, for instance when only the backend was built, the backend serves the API alone. `SCANNER_UI_DIR` points it at another build.

## Configuration

Environment variables, read at startup. `.env.example` has a starting point.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCANNER_TOKEN` | required | Shared bearer token |
| `SCANNER_MODELS` | required | Model Pool, JSON: `[{"id","provider","baseUrl?","apiKeyEnv?"}]` |
| `SCANNER_DEFAULT_MODEL` | first model | Default Model |
| `SCANNER_RUNNER` | `podman` | `podman` runs the agent; `fake` writes a placeholder Report |
| `SCANNER_AGENT_IMAGE` | `localhost/ai-scanner-agent:latest` | Image run for each Attempt |
| `SCANNER_EGRESS_PROXY_IMAGE` | `docker.io/library/node:22-alpine` | Image running the egress proxy |
| `SCANNER_AGENT_ENV` | — | Comma-separated server variables passed to the agent (API keys) |
| `SCANNER_AGENT_MEMORY` | `4g` | Memory limit per agent container |
| `SCANNER_PODMAN` | `podman` | Podman executable |
| `SCANNER_DATA_DIR` | `data` (`/data` in the image) | Database, Source Archives, Artifacts |
| `SCANNER_PROFILES_DIR` | `profiles/` | Scan Profiles |
| `SCANNER_UI_DIR` | `ui/dist/` | Built web UI |
| `SCANNER_DEFAULT_LANGUAGE` | `en` | Report language when the caller gives none |
| `SCANNER_MAX_ARCHIVE_MB` | `200` | Upload size limit |
| `SCANNER_MAX_EXTRACTED_MB` / `SCANNER_MAX_EXTRACTED_FILES` | `1024` / `100000` | Extraction limits |
| `SCANNER_MAX_INSTRUCTIONS_LENGTH` | `2000` | Characters of caller instructions |
| `SCANNER_MAX_ATTEMPTS` | `3` | Attempts before a Scan fails |
| `SCANNER_ATTEMPT_TIMEOUT_MINUTES` / `SCANNER_SCAN_TIMEOUT_MINUTES` | `20` / `60` | Timeouts |
| `SCANNER_CONCURRENCY` | `2` | Scans running at once |
| `SCANNER_RETENTION_DAYS` / `SCANNER_SWEEP_INTERVAL_MINUTES` | `365` / `60` | Retention, and how often it is enforced (`0` = never) |
| `PORT` | `3000` | HTTP port |

## Isolation

Each Attempt runs opencode in its own ephemeral Podman container ([ADR-0003](docs/adr/0003-isolated-container-per-scan.md)). The container has a read-only root filesystem and no capabilities. The code is mounted read-only, the agent has no shell, and the only network route out is an egress proxy that lets through the Model Pool's endpoints and nothing else. Source Archives are extracted with size and file-count limits and with path-traversal rejection.

## Container images

The root [`Containerfile`](Containerfile) builds the service image. It is multi-stage: the UI is built with Vite, the backend with `nest build`, and the runtime image holds only production dependencies. It runs as `node`, listens on `3000` and keeps its data in the `/data` volume.

```sh
make image
podman run --rm -p 3000:3000 -v ai-scanner-data:/data \
  -e SCANNER_TOKEN=change-me -e SCANNER_RUNNER=fake \
  -e SCANNER_MODELS='[{"id":"claude-sonnet-5-5","provider":"anthropic"}]' \
  ghcr.io/gpillon/ai-scanner:dev
```

[`containers/agent/Containerfile`](containers/agent/Containerfile) builds the agent image the Podman Runner starts for each Attempt.

> **Limit:** the service image does not run real Scans yet. The Podman Runner starts sibling containers through a `podman` executable, and it bind-mounts paths from its own filesystem (the Scan workspace, the output directory, the proxy script). Inside the service container there is no `podman`, and those paths would not exist on the host. For now, use the image with `SCANNER_RUNNER=fake`, or run the service directly on the host. A Kubernetes/OpenShift Runner is the planned way to run Scans from a container (ADR-0003).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:

1. It typechecks the backend and the UI, runs the e2e suite and builds both.
2. It builds `ghcr.io/<owner>/ai-scanner` and `ghcr.io/<owner>/ai-scanner-agent`, and pushes both to GHCR, except on pull requests.

Tags: branch name, `sha-<short>`, `latest` on the default branch, and `X.Y.Z` / `X.Y` for `vX.Y.Z` git tags. The workflow logs in to GHCR with `GITHUB_TOKEN`, so the only setup is making the packages public in GitHub if they should be.

## Tests

`make test` runs the e2e suite (Jest and supertest) against the real Nest app, with a scripted stand-in for the agent. The Podman smoke tests (`test/podman.smoke.e2e-spec.ts`) start real containers and are skipped unless `SCANNER_SMOKE=1`. The file's header explains how to point them at a model.

## Layout

```
src/          NestJS backend, one folder per feature module
  main.ts, app.module.ts, app.setup.ts   bootstrap, root module, pipes/OpenAPI/UI
  core/       global module: configuration and Clock
  config/     environment variables to AppConfig
  common/     bearer guard, Clock, on-disk paths, app root
  scans/      Scans: controller, service, supervisor, retention, upload, DTOs, entity
  runner/     Runner port, Podman and fake adapters
  profiles/   Scan Profiles and GET /api/profiles
  models/     Model Pool and GET /api/models
  artifacts/  Artifact store
  reports/    findings.json checks, Report Template, PDF rendering
ui/           Web UI (Vite + React + PatternFly)
profiles/     Scan Profiles: prompt, skills, Report Template
containers/   Agent image and egress proxy
test/         e2e suite and fixtures
docs/adr/     Architecture decision records
```
