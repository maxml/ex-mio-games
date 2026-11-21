# Contracts Map — consumed boundaries (provenance registry)

**Purpose.** This repo is multi-component (web, api, shared packages). Components
depend on each other through **named contracts** — stable behaviour + semantics —
not through internal `file:line` addresses. This file is the single place that
records each contract: its semantics, the canonical specification, and the
current implementation evidence. Verified 2026-08-15. Paths are relative to the
repo root.

**Contract trigger.** Only a stabilized boundary between components or a critical
integration earns an entry — not every helper or dependency. Each entry below is
a deliberate swap point or an external integration, not an ordinary import.

**Ownership.** The `provider` owns the canonical spec; this (consumer-side)
registry holds provenance and **points** at the spec, it does not copy it. One
semantics never lives in two maps.

**One-file rule (bounded).** A refactor that only moves where the behaviour lives
(new `implementation evidence` / `last_verified`) is a change to this file alone.
Changing a contract's **meaning** is not: update the canonical spec + conformance
test, then notify consumers.

**Version discipline.** Workspace packages that form the narrow waist
(`@ex-mio/shared-types`, `@ex-mio/auth`) carry semver
package versions. Local consumers depend on them through `workspace:^1.0.0`
ranges, not `workspace:*`, so generated projects inherit an explicit compatible
major instead of accepting any local package version.

> `implementation evidence` (`file:line` / file) is **provenance, not truth** — a
> brittle pointer to where the behaviour lives today. The contract is the
> meaning, not the address.

---

## Web ↔ API HTTP boundary

### `shared-types schemas`

- **provider:** `packages/shared-types` (`@ex-mio/shared-types`) ·
  **consumers:** `apps/api` (validates request/response, derives the OpenAPI
  schema), `apps/web` (intended HTTP client of the same shapes)
- **semantics:** canonical wire shapes both sides agree on — `User`,
  `CreateUserInput`, `HealthCheck` / `HealthStatus` / `DependencyHealth`,
  storage file DTOs (`FileRecord`), and queue job DTOs
  (`QueueEnqueueInput`, `QueueEnqueueResult`, `HeartbeatJobPayload`). Zod is the
  single schema source; the API serializes/validates from it.
- **canonical specification:** the Zod schemas in
  `packages/shared-types/src/{user,health,storage,queue}.ts`
- **implementation evidence:** `packages/shared-types/src/{user,health,storage,queue}.ts`;
  enforced in `apps/api/src/users/users.controller.ts`,
  `apps/api/src/health/health.controller.ts`,
  `apps/api/src/storage/files.controller.ts`, and
  `apps/api/src/queue/queue.controller.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **version:** `@ex-mio/shared-types@1.0.0` ·
  **last_verified:** 2026-08-15
- **conformance test:** `apps/api/src/__tests__/server.test.ts` (asserts the
  OpenAPI paths expose the schemas; `400` on invalid `CreateUserInput`).
  `apps/web` consumes the package through its FSD `shared/types` segment
  (`apps/web/src/layers/shared/types` re-exports it; the MSW handlers and the WS
  client narrow against it), so the contract is enforced on both sides.
  `packages/shared-types/src/http.contracts.test.ts` pins the package barrel and
  the documented HTTP Zod wire schemas. Storage and queue barrel/wire contracts
  are pinned by `packages/shared-types/src/storage.contracts.test.ts` and
  `packages/shared-types/src/queue.contracts.test.ts`.

### `web runtime API base`

- **provider:** `apps/web` runtime config
  (`apps/web/src/layers/shared/config/runtime.ts`, surfaced by
  `apps/web/app/config/route.ts`) · **consumers:** the web SSR path (server-side
  fetches to the API) and the browser (via `/config`)
- **semantics:** the web image is **domain-agnostic** — no API domain is baked at
  build time. Base-URL precedence: the **browser** defaults to the SAME ORIGIN
  (single-host routing sends `/api/*` etc. to the API), overridable at runtime by
  `PUBLIC_API_URL` from the `/config` endpoint; the **SSR** base is `API_URL` (an
  internal service URL, e.g. `http://api:4000`, so SSR never egresses to the public
  proxy). `NEXT_PUBLIC_API_URL` is only an OPTIONAL build-time fallback (a
  non-single-host image). One image promotes dev → prod with no rebuild.
- **canonical specification:** `resolveApiBaseUrl` in
  `apps/web/src/layers/shared/config/runtime.ts`
- **implementation evidence:** `apps/web/src/layers/shared/config/runtime.ts`,
  `apps/web/app/config/route.ts`, `apps/web/Dockerfile` (no required build-arg);
  the deploy contract wires `services.web.env.API_URL` and
  `env.runtime_public: ['PUBLIC_API_URL']` in `.deckhand/deploy.yml`.
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-09-06
- **conformance test:** `apps/web/src/layers/shared/config/runtime.test.ts`,
  `apps/web/src/test/config-route.test.ts`, and
  `apps/web/src/test/dockerfile.test.ts` (asserts the manifest bakes no
  `NEXT_PUBLIC_API_URL` domain).

---

## Internal facades (swap points)

These boundaries exist so the setup generator can swap implementations
(DB engine, auth provider, error backend) without touching route code. Route /
controller code MUST depend on the interface, never on the concrete backend.

### `AppDatabase facade`

- **provider:** `apps/api/src/db` (consumer-designed façade owned by the API) ·
  **consumers:** `apps/api` routes / controllers
- **semantics:** `connect` / `disconnect` / `ping` / `listUsers` / `createUser`;
  `createUser` throws `DuplicateUserError` on a unique-email violation. No
  route/controller imports Prisma/TypeORM directly.
- **canonical specification:** the `AppDatabase` interface in
  `apps/api/src/db/index.ts`
- **implementation evidence:** `apps/api/src/db/index.ts` (TypeORM + PostgreSQL behind the `AppDatabase` facade)
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-08-02
- **conformance test:** `apps/api/src/__tests__/server.test.ts` (injects a fake
  `AppDatabase`)

### `AuthService facade`

- **provider:** `packages/auth` (`@ex-mio/auth`) — consumer-designed
  façade: the API layer defines the verb set; the package owns the interface plus
  the framework-agnostic Custom auth core ·
  **consumers:** the API auth wiring emitted at `setup`, and the scaffolded
  providers (`custom` / `firebase`)
- **semantics:** `verifyToken` (required) plus optional password / Google-OAuth
  verbs; `AuthUser` / `AuthSession` shapes. Providers sit behind one interface;
  route code never imports a provider SDK directly.
- **canonical specification:** the `AuthService` interface in
  `packages/auth/src/index.ts`
- **implementation evidence:** `packages/auth/src/index.ts`,
  `packages/auth/src/custom.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **version:** `@ex-mio/auth@1.0.0` ·
  **last_verified:** 2026-08-02
- **conformance test:** `packages/auth/src/auth.test.ts`;
  `packages/auth/src/contracts.test.ts` pins the public package barrel and the
  `AuthService` facade shape consumed by the API layer.

### `ErrorReporter facade`

- **provider:** `apps/api/src/error-reporter` ·
  **consumers:** API error paths (`apps/api/src/index.ts`, server)
- **semantics:** `report(err, context?)`. A console reporter is the default;
  the backend is pluggable — `setErrorReporter(reporter)` swaps in any
  `ErrorReporter` implementation. No direct reporter calls in route code.
- **canonical specification:** the `ErrorReporter` interface in
  `apps/api/src/error-reporter/index.ts`
- **implementation evidence:** `apps/api/src/error-reporter/index.ts` (the
  console reporter is the default and only bundled implementation; no error
  backend ships with the starter)
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-08-02
- **conformance test:** `none yet` — `server.test.ts` covers the "no error
  reported on a 400" path, but the reporter contract has no dedicated test.

### `StorageService facade`

- **provider:** `apps/api/src/storage` (consumer-designed facade owned by the
  API) · **consumers:** `apps/api` file routes and health reporting
- **semantics:** `put` / `get` / `delete` / `exists` / `getUrl` over opaque
  validated storage keys. LocalDisk stores under a configured root and serves
  through `/api/files/:key`; S3-compatible storage returns a signed URL. Upload
  validation uses multipart streaming to enforce the size limit while reading,
  applies a content-sniffed MIME allow-list, preserves stored content metadata,
  validates safe filenames, and keeps path/symlink safety at the driver boundary.
- **deploy constraint:** LocalDisk is **not blue-green-safe** — a public
  (blue-green) service cannot own a durable volume, so per-instance disk is lost on
  cutover; use the **S3 driver** for durable files behind a public API. The boot
  writable-root preflight (Operational contracts below) refuses to serve if the
  configured LocalDisk root is unwritable or on the ephemeral container overlay.
  See `.deckhand/deploy.yml` (storage warning) and ADR-0010.
- **canonical specification:** `StorageService` in `apps/api/src/storage/index.ts`
  - ADR-0008 (`docs/adts/0008-file-storage-facade.md`)
- **implementation evidence:** `apps/api/src/storage/index.ts`,
  `apps/api/src/storage/files.controller.ts`,
  `apps/api/src/storage/storage.module.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-08-15
- **conformance test:** `apps/api/src/storage/storage.test.ts`,
  `apps/api/src/__tests__/server.test.ts`

### `QueueService facade`

- **provider:** `apps/api/src/queue` (consumer-designed facade owned by the API) ·
  **consumers:** `apps/api` enqueue route, health reporting, Bull Board mount,
  and `apps/worker` via the shared job contracts
- **semantics:** `enqueue(jobName, payload, opts)` validates the shared Zod job
  payload, accepts caller-supplied `jobId` for idempotency, and uses a
  BullMQ-specific Redis connection with `maxRetriesPerRequest: null`. When the
  queue dimension is enabled, `REDIS_URL` is required at API/worker boot and
  queue health is a readiness dependency. The default baseline keeps queue
  enabled, so Redis is required unless setup subtracts the queue/Redis
  dimensions. Bull Board is read-only, AuthService-protected, and off in
  production unless explicitly enabled.
- **canonical specification:** `QueueService` in `apps/api/src/queue/index.ts`
  - ADR-0007 (`docs/adts/0007-background-jobs-and-queue.md`)
- **implementation evidence:** `apps/api/src/queue/index.ts`,
  `apps/api/src/queue/queue.controller.ts`,
  `apps/api/src/queue/bull-board.ts`, `apps/worker/src/processor.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-08-15
- **conformance test:** `apps/api/src/queue/queue.test.ts`,
  `apps/api/src/queue/bull-board.test.ts`,
  `apps/api/src/__tests__/server.test.ts`; the starter smoke harness runs a
  queue-on Redis + worker heartbeat cell before producing templates.

---

## Operational contracts

### `Health probes`

- **provider:** `apps/api` ·
  **consumers:** container orchestrator / load balancer / uptime monitors
- **semantics:** `GET /healthz/live` → `200` without touching dependencies;
  `GET /healthz/ready` → `503` when a required dependency is down;
  `GET /healthz` → full `HealthCheck` report with per-dependency latency.
  **Invariant:** **liveness** stays `200` during incidents (the process is up),
  but **readiness** returns `503` when a required dependency is down so the
  orchestrator stops routing to the instance. Optional dependencies (Redis when
  queue is off, and storage by default) only mark `/healthz` `degraded`; they
  never flip readiness. When `queue` is enabled, queue/Redis becomes required
  and `/healthz/ready` returns `503` if it is down. The **web** app answers its
  own dependency-free `GET /health` → `200` `{status:"ok", version}`
  (`apps/web/app/health/route.ts`), which gates the web service's readiness. Under
  single-host routing the edge sends `/api/*`, `/socket.io/*`, `/healthz*`
  (prefix), and `/docs*` to the API and everything else to web
  (`.deckhand/deploy.yml` → `services.*.public.paths`); the `/healthz*` **prefix**
  is what keeps `/healthz/live|ready` on the API (a bare `/healthz` would not).
- **canonical specification:** the `HealthCheck` schema
  (`packages/shared-types/src/health.ts`) + the "Endpoints" section of
  `README.md`
- **implementation evidence:** `apps/api/src/health/health.controller.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-08-15
- **conformance test:** `apps/api/src/__tests__/server.test.ts`

### `Production DATABASE_URL / REDIS_URL TLS`

- **provider:** the boot guards in `apps/api/src/config` and
  `apps/worker/src/config.ts` ·
  **consumers:** the deploy/runtime operator provisioning env vars
- **semantics:** in `production` the API fails fast on boot unless `DATABASE_URL`
  enables TLS (Mongo: `mongodb+srv://` or `tls=true`; Postgres:
  `sslmode=require` / `verify-ca` / `verify-full`), and — when configured —
  `REDIS_URL` uses TLS (`rediss://` or `tls=true`); the worker enforces the same
  `REDIS_URL` guard. These guards MUST NOT be weakened. Operational note: Postgres
  `sslmode=require` encrypts without verifying, so a self-signed cert works, but
  the Redis client (ioredis) **verifies** the `rediss://` cert — self-hosted Redis
  needs a trusted (not self-signed) cert, or use a managed TLS datastore (ADR-0010).
- **canonical specification:** `apps/api/src/config/index.ts` +
  `apps/worker/src/config.ts` + `memory/systemPatterns.md` (Security constraints)
- **implementation evidence:** `apps/api/src/config/index.ts`,
  `apps/worker/src/config.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-09-06
- **conformance test:** `apps/api/src/config/config.test.ts`

### `Storage writable-root preflight`

- **provider:** `apps/api/src/config/preflight.ts` (wired at
  `apps/api/src/index.ts`) · **consumers:** the deploy/runtime operator
  provisioning the LocalDisk storage mount
- **semantics:** before serving traffic, the API write-probes every configured
  storage root and refuses to start if it is unwritable — catching a read-only
  mount or a non-root process (uid 10001) against a root-owned mount. In a
  production container it additionally refuses to serve when the root is on the
  ephemeral overlay (same device as `/`), catching the common "forgot the volume"
  case. It is **not** a full durability guarantee (a tmpfs/k8s emptyDir on its own
  device passes) — durability remains the orchestrator's responsibility.
- **canonical specification:** `runStoragePreflight` / `assertWritableRoots` in
  `apps/api/src/config/preflight.ts`
- **implementation evidence:** `apps/api/src/config/preflight.ts`,
  `apps/api/src/index.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-09-06
- **conformance test:** `apps/api/src/config/preflight.test.ts`

---

## Web ↔ Gateway realtime boundary

These cover the socket.io gateway (R2,
[`docs/adts/0003-realtime-websocket-architecture.md`](adts/0003-realtime-websocket-architecture.md)).
The gateway is colocated in `apps/api` behind the optional `realtime` setup
dimension; the web client (R3) is the intended consumer.

### `Realtime event contract`

- **provider:** `packages/shared-types` (`@ex-mio/shared-types`) ·
  **consumers:** `apps/api` realtime gateway (validates inbound frames), the
  intended web WS client (R3, narrows inbound events)
- **semantics:** generic socket.io envelope both sides agree on — the
  `notifications` namespace, the `ping`/`pong`, `subscribe`, and `notification`
  event names, and their Zod payload/ack shapes (`PingInput`, `PongAck`,
  `SubscribeInput`, `SubscribeAck`, `NotificationEnvelope`). Domain events layer
  on top of this envelope in the consuming app, not the template.
- **canonical specification:** the Zod schemas in
  `packages/shared-types/src/realtime.ts`
- **implementation evidence:** `packages/shared-types/src/realtime.ts`; validated
  at `apps/api/src/realtime/notifications.gateway.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **version:** `@ex-mio/shared-types@1.0.0` ·
  **last_verified:** 2026-08-02
- **conformance test:** `apps/api/src/realtime/__tests__/notifications.gateway.test.ts`
  (rejects a frame that fails its Zod schema);
  `packages/shared-types/src/realtime.contracts.test.ts` pins the realtime event
  names and envelope schemas exported from the package barrel.

### `WebSocket handshake auth`

- **provider:** the gateway connection auth in `apps/api/src/realtime` reusing the
  `AuthService facade` · **consumers:** any WS client connecting to the gateway
- **semantics:** on connection the gateway reads the token from
  `socket.handshake.auth.token` (falling back to the `Authorization` bearer via
  `getBearerToken`), resolves it with the wired `AuthService.verifyToken`, and
  **disconnects the socket when it is `null`** — no second auth system, no
  assumption about token shape (opaque session token for Custom, JWT for
  Firebase). CORS reuses the API's `CORS_ORIGIN` allow-list (never `*` in prod).
- **canonical specification:** the handshake section (§3) of
  `docs/adts/0003-realtime-websocket-architecture.md`
- **implementation evidence:** `apps/api/src/realtime/notifications.gateway.ts`
  (handshake) + `apps/api/src/realtime/io-adapter.ts` (CORS/transport/heartbeat/
  Redis adapter) + the wiring in `apps/api/src/server.ts` and
  `apps/api/src/app.module.ts`
- **status:** `backed` · **owner:** template maintainers ·
  **last_verified:** 2026-08-02
- **conformance test:** `apps/api/src/realtime/__tests__/notifications.gateway.test.ts`
  (valid token connects; missing/invalid token disconnects)
