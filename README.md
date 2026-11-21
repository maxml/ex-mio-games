# ex-mio-games

[![CI](https://github.com/your-org/ex-mio/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/ex-mio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](.nvmrc)

A minimal, production-leaning Nx + pnpm template for building TypeScript
fullstack apps:

- **Web** — Next.js 14 (App Router, Feature-Sliced Design) + Tailwind + TanStack Query + Zustand + react-hook-form/Zod + next-intl
- **API** — NestJS 11 (Fastify adapter) + TypeORM + PostgreSQL + Zod-validated OpenAPI + baseline auth + socket.io realtime
- **Shared types** — Zod schemas reused across web and api
- **Tooling** — ESLint, Prettier, Husky, lint-staged, Vitest + Jest, Playwright, MSW, Storybook, Dockerfiles, GitHub Actions CI

## What this starter answers

The questions a production-leaning fullstack repo has to answer, and where this
template stands on each. Use it to see at a glance what's wired up.

**Included in the baseline:**

- [x] **Monorepo orchestration & caching** — Nx (project graph, affected, cache)
- [x] **Package management** — pnpm workspaces + workspace-protocol deps
- [x] **Configuration & env validation** — Zod-validated config, fail-fast on boot
- [x] **Database & ORM** — TypeORM + PostgreSQL (swap to TypeORM/Postgres or Prisma/Mongo via setup)
- [x] **Production DB TLS** — startup guard rejects non-TLS `DATABASE_URL` in production
- [x] **Telemetry** — structured Pino logs (Varta §3.1 shape, `@ex-mio/logger`) + OpenTelemetry OTLP metrics (`varta_build_info` + HTTP server metrics); additive & opt-in — both no-op until `OTEL_EXPORTER_OTLP_ENDPOINT` is set, no runtime dependency on Varta (NestJS only; opt out at setup)
- [x] **Error reporting** — pluggable `ErrorReporter` facade (console reporter by default; swap in your own backend via `setErrorReporter`)
- [x] **Health checks** — liveness / readiness / full dependency report
- [x] **API contract & docs** — Zod schemas + OpenAPI / Swagger UI
- [x] **Input validation** — Zod, shared between web and api
- [x] **Auth** — Custom (wired in the baseline: password + session + Google OAuth) / Firebase (chosen at setup)
- [x] **API framework** — NestJS (default) or Fastify (chosen at setup)
- [x] **Frontend architecture** — Feature-Sliced Design (FSD) with ESLint `import/no-restricted-paths` + Steiger boundaries
- [x] **Web data & forms** — TanStack Query + Zustand + react-hook-form + Zod (schemas shared with the api)
- [x] **HTTP client** — typed fetch wrapper + unified error envelope
- [x] **Design system** — Tailwind tokens + `shared/ui` components + Storybook
- [x] **i18n** — next-intl, locale-routed (`/[locale]`), seed `en`/`uk`
- [x] **Caching** — optional shared Redis facade (`REDIS_URL`) + `/healthz` check (opt out at setup)
- [x] **Realtime** — socket.io gateway (JWT/session handshake + optional Redis adapter) + singleton web client (opt out at setup)
- [x] **Containerization** — per-app Dockerfiles + `docker-compose` (Postgres + Redis + CloudBeaver)
- [x] **Deploy manifest** — optional `.deckhand/deploy.yml` for the Deckhand blue-green delivery system (requires Docker; opt out at setup)
- [x] **CI** — GitHub Actions with `nx affected`
- [x] **Lint / format / pre-commit** — ESLint, Prettier, Husky, lint-staged
- [x] **Testing** — Vitest (web) + Jest (api & libs), MSW request mocks, Playwright e2e
- [x] **Dependency & code security scanning** — Snyk SCA/SAST CI gate ([details](#security-scanning))

## Structure

```
.
├── apps/
│   ├── web/          # Next.js 14 + Tailwind
│   ├── api/          # NestJS + TypeORM + PostgreSQL + Swagger UI
├── packages/
│   ├── auth/         # provider facade + Custom auth core
│   └── shared-types/ # Zod schemas shared by web/api
│   └── scripts/      # Runtime helper scripts kept in generated projects
├── docs/
│   └── adts/         # architecture decision records (the "why")
├── docker-compose.yml  # Postgres 16 + Redis + CloudBeaver (web DBeaver)
├── nx.json
└── pnpm-workspace.yaml
```

## Quick start

```bash
nvm use                      # picks up Node from .nvmrc
pnpm install
docker compose up -d         # Postgres on :5432, Redis on :6379, CloudBeaver on :8081

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

pnpm --filter api prisma:push   # fast local schema sync (prototyping)
pnpm dev                        # web on :3000, api on :4000
```

`prisma:push` is the quick local loop; production applies the tracked migrations
under `apps/api/prisma/migrations/` via `prisma migrate deploy` (see the deploy
manifest below). After editing `schema.prisma`, run `pnpm --filter api prisma:migrate`
to author the next migration.

### Run Worktrees In Parallel

For multiple checkouts of the same project, use the local stack orchestrator:

```bash
pnpm stack:up
```

It allocates the next free host ports for the web, API, database, Redis, and
local admin tools; starts Docker infra under a worktree-specific
`COMPOSE_PROJECT_NAME`; runs the dev DB sync; then launches web/api/worker as
separate processes with their own env blocks. This keeps ports and Docker
volumes isolated across git worktrees. The printed URLs are authoritative.

`Ctrl-C` stops the app processes and leaves infra data running. To stop the
worktree's Docker infra:

```bash
pnpm stack:down
```

`pnpm dev` still uses the fixed default ports and remains the simpler path for a
single checkout.

### Per-workspace commands

```bash
pnpm --filter web dev
pnpm --filter api dev
pnpm --filter api test
```

## Endpoints

- Web: <http://localhost:3000>
  - `GET /health` — web readiness probe; bare `200 {"status":"ok","version":<APP_VERSION|null>}`,
    dependency-free, never locale-redirected (drives the Deckhand cutover gate)
  - `GET /config` — browser runtime config `{ "apiUrl": <string> }`, resolved at
    request time (empty = same origin); see [Runtime web configuration](#runtime-web-configuration)
- API: <http://localhost:4000>
  - `GET /healthz/live` — liveness probe; does not touch dependencies
  - `GET /healthz/ready` — readiness probe; fails when required dependencies are down
  - `GET /healthz` — full dependency health report with latency
  - `GET /api/users` — list users
  - `POST /api/users` — create a user
  - Swagger UI: <http://localhost:4000/docs>
- CloudBeaver (web DBeaver): <http://localhost:8081> — on first launch, finish
  the setup wizard, then add a PostgreSQL connection to
  `host.docker.internal:5432` (db `ex_mio`, user/password
  `starter`/`starter`). When running through `pnpm stack:up`, use the printed
  Postgres host port instead of assuming `5432`. On environments where the host
  gateway isn't available (some rootless Docker / Podman setups), use the
  in-network host `postgres:5432` instead.

## Scripts

```bash
pnpm dev           # nx run-many -t dev
pnpm stack:up      # worktree-safe local stack with next-free ports
pnpm stack:down    # stop this worktree's Docker infra
pnpm build         # builds web, api, and packages
pnpm lint          # ESLint across all workspaces
pnpm test          # Jest in apps/api (and any other workspace tests)
pnpm format        # rewrite files with Prettier
pnpm format:check  # CI-friendly check, no rewrite
```

## Architecture

Nx owns the project graph, local cache, affected CI.
To inspect workspace relationships locally, run:

```bash
pnpm nx graph
```

The current baseline keeps libraries in `packages/`; the optional
`packages/` -> `libs/` rename is deferred because it is cosmetic and not
required for Nx generators or affected CI.

## Environment variables

### `apps/api/.env`

| Variable               | Default                                              | Notes                                                                                                                |
| ---------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `development`                                        | `development` \| `production` \| `test`                                                                              |
| `PORT`                 | `4000`                                               |                                                                                                                      |
| `LOG_LEVEL`            | `info`                                               | `debug` \| `info` \| `warn` \| `error`                                                                               |
| `APP_VERSION`          | (unset)                                              | `version` field in `/healthz`; falls back to package version                                                         |
| `CORS_ORIGIN`          | `http://localhost:3000`                              | Comma-separated allow-list. `*` is dev-only (credentials are enabled, so the config guard rejects `*` in production) |
| `DATABASE_URL`         | `postgresql://starter:starter@localhost:5432/ex_mio` | PostgreSQL connection string                                                                                         |
| `REDIS_URL`            | `redis://localhost:6379`                             | Redis (ioredis). Required at boot by the default queue-enabled baseline; TLS (`rediss://`) required in production    |
| `AUTH_SECRET`          | `replace-with-a-long-random-secret`                  | Custom auth: signs session/OAuth-state tokens. The auth core throws in production if missing or at the placeholder   |
| `GOOGLE_CLIENT_ID`     | (unset)                                              | Custom auth: Google OAuth client id; required only for the `/api/auth/google/*` flow                                 |
| `GOOGLE_CLIENT_SECRET` | (unset)                                              | Custom auth: Google OAuth client secret used to exchange auth codes                                                  |
| `GOOGLE_REDIRECT_URI`  | `http://localhost:4000/api/auth/google/callback`     | Custom auth: callback URL registered in Google Cloud                                                                 |

Production database URLs must enable SSL/TLS. For MongoDB, use
`mongodb+srv://...` or add `tls=true`. For PostgreSQL variants, use
`sslmode=require`, `sslmode=verify-ca`, or `sslmode=verify-full`.

### `apps/web/.env.local`

| Variable              | Default                               | Notes                                                                                                                                  |
| --------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000`               | Build-time API base for the browser. Needed for the `next dev` cross-origin case (web :3000 → api :4000). Optional in prod (see below) |
| `API_URL`             | (falls back to `NEXT_PUBLIC_API_URL`) | Runtime, non-public SSR base for web → API calls. In prod, the **internal** API URL (e.g. `http://api:4000`)                           |
| `PUBLIC_API_URL`      | (unset → same origin)                 | Runtime browser API base served by `/config`. Empty means same origin; set only for `single_host: false` / cross-origin access         |

See [Runtime web configuration](#runtime-web-configuration) for how these resolve.

### Runtime web configuration

Next.js inlines `NEXT_PUBLIC_*` into the bundle at **build** time, which would
freeze a domain into the web image and force a rebuild to promote dev → prod. The
web app instead resolves the API base at **runtime** (see
`apps/web/src/layers/shared/config/runtime.ts`), so **one image is
domain-agnostic** and needs no rebuild between environments:

- **Browser** — defaults to the **same origin** (relative `/api`, `/healthz`,
  `…`). Under single-host path routing the edge proxy sends those paths to the
  API, so no domain is baked. `NEXT_PUBLIC_API_URL` (dev) or a runtime-injected
  `window.__APP_CONFIG__` can still point it cross-origin.
- **Realtime (WebSocket)** — resolves the same way (`resolveWsBaseUrl`), driven
  by the **same** override surface. It defaults to the **same origin** derived
  from the page at runtime — `wss://<host>` on https, `ws://<host>` on http —
  plus the `/socket.io` path the single-host proxy routes to the API. So the
  domain-agnostic image (built with no `NEXT_PUBLIC_API_URL`) has realtime **ON**,
  never off. The cross-origin case is the same override as HTTP: set
  `NEXT_PUBLIC_API_URL` (dev) or inject `window.__APP_CONFIG__.apiUrl` — the WS
  origin follows the API origin, scheme swapped to `ws`/`wss`.
- **Server (SSR)** — reads `API_URL` at request time (falling back to
  `NEXT_PUBLIC_API_URL` for dev). A server fetch needs an absolute origin, so
  when neither is set the SSR health card degrades to "unreachable" instead of
  crashing.
- **`GET /config`** — a `force-dynamic` route that returns the browser-facing
  config `{ apiUrl }` from `PUBLIC_API_URL` at request time (empty = same origin).
  Use it to verify runtime resolution (`curl …/config` in each environment) and,
  for a `single_host: false` deployment, to bootstrap `window.__APP_CONFIG__`
  before making cross-origin calls.
- **`GET /health`** — the web readiness probe; `force-dynamic` so it reports the
  running build's `version` from the runtime `APP_VERSION` env (see the deploy
  manifest's `version.inject_as`).

> Realtime is same-origin by default: a web image built with no
> `NEXT_PUBLIC_API_URL` still speaks WebSocket to whatever host serves it (the
> `/socket.io` path is routed to the API by the single-host proxy). Bake
> `NEXT_PUBLIC_API_URL` (or inject `window.__APP_CONFIG__.apiUrl`) only for the
> cross-origin / `single_host: false` case.

## Docker

Production images for each app:

```bash
docker build -f apps/api/Dockerfile -t ex-mio-api .

# The web image is domain-agnostic: no build args needed. The browser talks to
# the API on the same origin (relative /api, /healthz — routed to the API by the
# single-host edge proxy), and the SSR base is read at runtime from API_URL. One
# image promotes dev → prod with no rebuild.
docker build -f apps/web/Dockerfile -t ex-mio-web .

# Only for a cross-origin / single_host:false setup: bake an absolute browser API
# URL at build time (otherwise leave it unset).
docker build -f apps/web/Dockerfile -t ex-mio-web \
  --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
  .
```

The build context must be the repo root so the Dockerfiles can access the
`pnpm-lock.yaml` and workspace packages. `.env*` files are excluded from the
build context (see `.dockerignore`); pass API secrets at runtime with
`docker run --env-file apps/api/.env` (or `-e`), never baked into the image.

> `docker compose up -d` starts only the **local infrastructure** (Postgres,
> Redis, CloudBeaver) — not the apps. Run the apps either without Docker
> (`pnpm dev`), through the worktree-safe local orchestrator (`pnpm stack:up`),
> or as the per-app production images above.

### Deploy manifest (Deckhand)

`.deckhand/deploy.yml` is this project's deploy contract for the external
**Deckhand** blue-green delivery system. It declares how to build and roll out
the app — images, services (each `blue-green` or `singleton`), the public
routing, an env inventory (names only), the version source, and the DB migration
step — while publishing no host ports except the edge proxy. Local
`pnpm stack:up` host-port allocation is intentionally separate from this deploy
contract; Deckhand routes traffic by service name and internal container port.

`setup` regenerates the manifest for the selected stack: database provider,
Redis, worker service, realtime path, auth env inventory, storage env inventory,
and Prisma/TypeORM migration command. The API answers `/healthz/{live,ready}`
and the web answers `/health` for the readiness gate that drives cutover. Opt out
at setup to remove `.deckhand/` entirely.

Migrations run as a **deploy step** (`migrations.when: expand-before-cutover`),
never on app boot, so blue and green both run against the expanded,
backward-compatible schema. On the Prisma-Postgres baseline the manifest runs
`pnpm --filter api exec prisma migrate deploy` against the committed migrations —
`exec` runs the prisma **binary** (a bare `pnpm --filter api prisma migrate deploy`
treats `prisma` as a script name and exits 0, silently deploying an empty
schema). The production config also fails fast unless `DATABASE_URL`/`REDIS_URL`
use TLS, `CORS_ORIGIN` is a non-wildcard allow-list, and `AUTH_SECRET` is a real
secret — see [ADR-0009](docs/adts/0009-prisma-production-migrations.md). Infra
services (`db`, `redis`) are `internal: true` and publish no host ports. The
overall deploy model — blue-green behind a shared edge, TLS to the datastores,
LocalDisk-vs-S3 for a public API, `/healthz*` routing, and the interim
build-on-VPS recipe — is recorded in
[ADR-0010](docs/adts/0010-deploy-model-and-interim-compose.md).

## CI

`.github/workflows/ci.yml` runs on every push and PR:

- `pnpm nx format:check --base=$NX_BASE --head=$NX_HEAD`
- `pnpm nx affected -t lint build test`

A PostgreSQL service container is started so Prisma can connect during tests.
CI is free for public repositories on GitHub Actions.

### Security scanning

A `security` job runs **Snyk** Open Source (SCA) and Snyk Code (SAST) against
the workspace, failing the PR on `high`/`critical` findings. It also runs
`snyk monitor` on pushes to `main`.

The job is **gated on the `SNYK_TOKEN` secret**: without it (forks, OSS PRs)
the steps skip and the job stays green — no contributor is blocked by a missing
secret.

To enable it:

1. Create a Snyk account (free tier works) and copy your token from
   <https://app.snyk.io/account>.
2. Add it as a GitHub Actions secret named `SNYK_TOKEN`
   (repo → Settings → Secrets and variables → Actions).

Run the same scan locally:

```bash
pnpm dlx snyk@1.1305.0 test --all-projects --severity-threshold=high
pnpm dlx snyk@1.1305.0 code test
```

Findings with no available fix go in `.snyk` as **time-boxed** `ignore` entries
(with an expiry), not permanent exceptions..

## License

[MIT](LICENSE) © ex-mio-games
