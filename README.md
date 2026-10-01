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
| `make chart-lint` | Lint the Helm chart and render it for Kubernetes and OpenShift |
| `make release VERSION=X.Y.Z` / `make release-push VERSION=X.Y.Z` | Set every version, commit and tag `vX.Y.Z` / push them (see [Releases](#releases)) |

`RUNNER`, `PORT`, `CONTAINER_ENGINE` (default `podman`), `IMAGE` and `TAG` can be overridden on the command line, e.g. `make image CONTAINER_ENGINE=docker TAG=test`.

## Using the API

Every `/api` endpoint requires `Authorization: Bearer <SCANNER_TOKEN>` ([ADR-0002](docs/adr/0002-no-user-concept-caller-chosen-scan-id.md)). The caller chooses the Scan id. `GET /api/scans` lists every Scan, so anyone with the token can read every Report.

```sh
TOKEN=change-me; ID=$(uuidgen | tr A-Z a-z)

curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/profiles
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/models

curl -H "Authorization: Bearer $TOKEN" -F file=@code.zip -F profile=security \
     -F language=en -F instructions="Focus on the payment module" \
     -F skillPacks=java,frontend \
     localhost:3000/api/scan/$ID

curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/scans              # every Scan, newest first
curl -H "Authorization: Bearer $TOKEN" localhost:3000/api/scan/$ID          # queued → running → succeeded | failed
curl -N -H "Authorization: Bearer $TOKEN" localhost:3000/api/scan/$ID/events  # follow it live (server-sent events)
curl -H "Authorization: Bearer $TOKEN" -o report.pdf localhost:3000/api/scan/$ID/artifacts/report.pdf
curl -H "Authorization: Bearer $TOKEN" -X DELETE localhost:3000/api/scan/$ID  # stop and remove
```

`/events` replays what already happened, then streams `state`, `attempt` and `activity` events until the Scan finishes. An `activity` event is a one-line summary of a tool call, a piece of the agent's text or a step, never the raw transcript. opencode reports each tool call and each block of text once it is complete, so the stream moves in steps rather than token by token. Browsers' `EventSource` cannot send the bearer header, so the UI reads the stream with `fetch`.

The OpenAPI document is at `/api/openapi.json`, and `/api/docs` renders it. Neither requires the token.

## Web UI

The UI lives in [`ui/`](ui): Vite, React, TypeScript and [PatternFly](https://www.patternfly.org). Its pages:

- **Scans**: every Scan on the server, newest first, with live state and a filter.
- **New Scan**: upload a zip and pick a profile, model, language and instructions. The Scan id is a random UUID.
- **Scan**: details, failure reason, Artifact downloads, a Findings table, and delete. An **Activity** log shows what the agent does as it does it, and still shows it after the Scan has finished.
- **Documentation**: the backend's Swagger UI, already signed in with your token.
- **Administration** (admin token only): **Models**, **Providers**, **Skill Packs** and **Skills**, see below.

In production the backend serves the built UI as static files under `/ui/`, and `/` redirects there. The UI is public: it holds no data, and it asks for the token to call the API. If `ui/dist` is missing, for instance when only the backend was built, the backend serves the API alone. `SCANNER_UI_DIR` points it at another build.

## Model Pool administration

Scans run on the models of the Model Pool, served by Providers ([ADR-0006](docs/adr/0006-model-pool-in-the-database-managed-by-an-admin.md)). Both live in the database. Sign in with `SCANNER_ADMIN_TOKEN` and the menu gains an Administration group:

- **Providers**: add an LLM API. Its kind is `anthropic`, `openai`, `google`, `mistral`, `groq`, `xai`, `openrouter`, or `openai-compatible` for vLLM, LM Studio, Ollama and any other OpenAI-style API, which needs a base URL. An API key typed here is stored encrypted under `SCANNER_SECRET_KEY` and never shown again. Without one, the kind's usual variable (e.g. `ANTHROPIC_API_KEY`) is read from the server's environment.
- **Models**: pick a Provider, and the server asks its API which models it offers. Add the ones Scans may use, enable or disable them, and choose the Default Model.

Agents may reach every Provider that serves a model, and nothing else. The egress proxy picks changes up without a restart. A disabled model still serves the Scans already using it. `SCANNER_MODELS` only fills an empty database on its first start: after that, edits to it are ignored.

The same operations are under `/api/admin` in the API reference.

## Skill Packs

A Scan Profile brings its own agent skills. Skill Packs add more for a given kind of codebase, e.g. `java`, `go` or `frontend` ([ADR-0008](docs/adr/0008-skill-packs-chosen-per-scan.md)). Callers list them with `GET /api/skill-packs` and add them to a Scan with `skillPacks` (comma-separated, or the field repeated). The New Scan form offers them as tags.

Admins manage them under Administration:

- **Skills**: import skills into the library, in one of two ways:
  - from a repository: the server runs the [`skills`](https://www.npmjs.com/package/skills) CLI (`skills add <source>`, pinned at 1.7.0) with a GitHub `owner/repo`, a Git URL or a tree URL, optionally limited to some skills;
  - from a zip of skill directories, each holding a `SKILL.md`.

  Skills are installed when imported, not when a Scan runs: the agent container has no network to fetch them. Each skill is checked: its frontmatter `name` must match its directory, it needs a `description`, and it must not shadow a Scan Profile's skill. Re-importing one needs "Replace".
- **Skill Packs**: name a group of library skills. A skill in a pack cannot be removed from the library.

Each Scan copies its profile's skills and its packs' skills at submission and keeps that copy, so later edits never change a queued or retried Scan. Its status lists every pack with the sha256 of each skill.

## Configuration

Environment variables, read at startup. `.env.example` has a starting point.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCANNER_TOKEN` | required | Shared bearer token |
| `SCANNER_ADMIN_TOKEN` | — | Admin token: opens the admin pages and routes. Without it, administration is disabled |
| `SCANNER_SECRET_KEY` | — | Encrypts stored Provider API keys (16+ characters). Without it, keys cannot be stored |
| `SCANNER_MODELS` | — | Seeds the Model Pool on the first start only, JSON: `[{"id","provider","baseUrl?","apiKeyEnv?"}]` |
| `SCANNER_DEFAULT_MODEL` | first model | Default Model of that seed |
| `SCANNER_RUNNER` | `auto` | `kubernetes` inside a pod, `podman` elsewhere; or set one of them, or `fake` (a placeholder Report) |
| `SCANNER_AGENT_IMAGE` | `localhost/ai-scanner-agent:latest` | Image run for each Attempt |
| `SCANNER_EGRESS_PROXY_IMAGE` | `docker.io/library/node:22-alpine` | Image running the egress proxy |
| `SCANNER_AGENT_ENV` | — | Comma-separated server variables passed to the agent (API keys) |
| `SCANNER_AGENT_MEMORY` | `4g` | Memory limit per agent container |
| `SCANNER_PODMAN` | `podman` | Podman executable |
| `SCANNER_K8S_DATA_CLAIM` | discovered | Kubernetes: the claim holding the data directory |
| `SCANNER_K8S_PROXY_IMAGE` | the server's image | Kubernetes: image of each Attempt's egress proxy pod |
| `SCANNER_K8S_COLOCATE` | `auto` | Kubernetes: pin agent pods to the server's node (`auto`: unless the claim is ReadWriteMany) |
| `SCANNER_K8S_AGENT_SERVICE_ACCOUNT` | namespace default | Kubernetes: ServiceAccount of agent pods |
| `SCANNER_K8S_AGENT_MEMORY` / `SCANNER_K8S_AGENT_CPU` | `4Gi` / `2` | Kubernetes: limits per agent pod |
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

Each Attempt runs opencode in its own ephemeral Podman container ([ADR-0003](docs/adr/0003-isolated-container-per-scan.md)), or its own pod on Kubernetes ([ADR-0007](docs/adr/0007-kubernetes-runner.md)). The container has a read-only root filesystem and no capabilities. The code is mounted read-only and the agent has no shell. Its only network route out is an egress proxy of its own, started and removed with the Attempt, which lets through its Scan's model endpoint and nothing else. With Podman the agent and its proxy share an internal network no other Attempt can reach; on Kubernetes the proxy is a separate pod, and per-Attempt NetworkPolicies let the agent reach that proxy only. Source Archives are extracted with size and file-count limits and with path-traversal rejection.

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

The service image runs real Scans on Kubernetes and OpenShift, where it starts one agent pod per Attempt: see [Kubernetes and OpenShift](#kubernetes-and-openshift). Under Podman it cannot start sibling containers, so there run it with `SCANNER_RUNNER=fake`, or run the service directly on the host.

## Kubernetes and OpenShift

The Helm chart in [`charts/ai-scanner`](charts/ai-scanner/README.md) installs the service. It detects OpenShift and adapts: UIDs come from the restricted SCC, and `expose.enabled` creates a Route there and an Ingress elsewhere.

```sh
helm repo add ai-scanner https://gpillon.github.io/ai-scanner
helm install scanner ai-scanner/ai-scanner -n ai-scanner --create-namespace
```

The server runs the Kubernetes Runner ([ADR-0007](docs/adr/0007-kubernetes-runner.md)). Each Attempt is a hardened pod in the same namespace, mounting the server's data volume, and it reaches the network only through its own egress proxy pod, which lets through only the Scan's model, under NetworkPolicies: no DNS, nothing else. The server discovers its own setup from its pod: data claim, node, images and pull secrets.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:

1. It typechecks the backend and the UI, runs the e2e suite and builds both.
2. It builds `ghcr.io/<owner>/ai-scanner` and `ghcr.io/<owner>/ai-scanner-agent`, and pushes both to GHCR, except on pull requests.

Tags: branch name, `sha-<short>`, `latest` on the default branch, and `X.Y.Z` / `X.Y` for `vX.Y.Z` git tags. The workflow logs in to GHCR with `GITHUB_TOKEN`, so the only setup is making the packages public in GitHub if they should be.

[`.github/workflows/helm-release.yml`](.github/workflows/helm-release.yml) lints the Helm chart on every change to it, and publishes it on release tags.

### Releases

A release is a `vX.Y.Z` tag on `main`:

```sh
make release VERSION=0.2.0       # sets the chart, appVersion and package versions, commits, tags
make release-push VERSION=0.2.0  # pushes main and the tag
```

On the tag:

- CI pushes both images as `0.2.0`.
- The chart `0.2.0` joins every earlier one in the `gh-pages` branch, which serves as the archive, and its entry is merged into the same `index.yaml`. The whole archive is then deployed to GitHub Pages: the Helm repository at `https://<owner>.github.io/<repo>` lists every version released, and a published version is never overwritten.

One-time setup: Settings > Pages > Source: GitHub Actions. The `gh-pages` branch is created on the first release.

## Tests

`make test` runs the e2e suite (Jest and supertest) against the real Nest app, with a scripted stand-in for the agent. The Podman smoke tests (`test/podman.smoke.e2e-spec.ts`) start real containers and are skipped unless `SCANNER_SMOKE=1`. The file's header explains how to point them at a model.

## Layout

```
src/          NestJS backend, one folder per feature module
  main.ts, app.module.ts, app.setup.ts   bootstrap, root module, pipes/OpenAPI/UI
  core/       global module: configuration and Clock
  auth/       bearer guard, admin token, GET /api/me
  skills/     Skill Library, Skill Packs, skills CLI import
  config/     environment variables to AppConfig
  common/     Clock, on-disk paths, app root
  scans/      Scans: controller, service, supervisor, retention, upload, DTOs, entity
  runner/     Runner port, Podman, Kubernetes and fake adapters, the agent spec they share
  profiles/   Scan Profiles and GET /api/profiles
  models/     Model Pool and Providers (database), discovery, GET /api/models, /api/admin
  artifacts/  Artifact store
  reports/    findings.json checks, Report Template, PDF rendering
ui/           Web UI (Vite + React + PatternFly)
profiles/     Scan Profiles: prompt, skills, Report Template
containers/   Agent image and egress proxy
charts/       Helm chart for Kubernetes and OpenShift
test/         e2e suite and fixtures
docs/adr/     Architecture decision records
```

## License

Apache License 2.0, see [LICENSE](LICENSE). Vendored skills keep their own licenses, see their NOTICE files.
