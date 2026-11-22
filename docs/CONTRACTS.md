# Contracts map

A contract is a stable behaviour between two components. This file is the single place that names each one:
what it means, who provides it, who consumes it, and the test that pins it. It points at the specification,
it does not copy it. Paths are relative to the repository root.

**Entry rule.** Only a boundary that other components rely on earns an entry. Changing a contract's meaning
means updating its entry and its conformance test in the same commit, and telling its consumers.

**Versioning.** Event payloads are versioned per type (`type` + `version`); a breaking payload change is a new
version, never an edit. HTTP shapes change additively; a removal waits until no consumer uses the field.

| Field    | Meaning                                         |
| -------- | ----------------------------------------------- |
| provider | the component that owns the specification       |
| consumer | components that depend on it                    |
| spec     | where the meaning is written (code or document) |
| pinned   | the test that fails if the contract is broken   |

---

## HTTP DTOs

- **provider:** `packages/contracts` (`src/http.ts`) · **consumers:** `identity`, `engagement`, `payments`,
  `web`, `tests/compose`
- **spec:** zod schemas. Controllers parse every input with them; the web client validates every response.
- **pinned:** `packages/contracts/src/*.contracts.test.ts`, `tests/compose`

## Web read models (player widget, operator console, platform admin)

- **provider:** `packages/contracts` (`src/web-api.ts`), provisional until the owning services publish
  final shapes · **consumers:** `web` (typed API client, mock adapter, HTTP adapter)
- **spec:** zod schemas. The widget never receives odds (segments carry labels only); the server picks the
  spin segment and the client only animates to it; acting as a tenant needs a reason.
- **pinned:** `packages/contracts/src/web-api.contracts.test.ts`, `apps/web/src/layers/shared/api/mio`

## Event envelope and event types

- **provider:** `packages/contracts` (`src/events.ts`) · **consumers:** every service that publishes or
  consumes events
- **spec:** `{ event_id (uuidv7), type, version, tenant_id, occurred_at, correlation_id, causation_id,
sandbox, payload }`; `tenant_id` is mandatory; the payload schema is registered per (type, version); an
  unknown type or version is rejected. `sandbox` (D-13, D-29 INV-ENV-INPUT) is a required boolean: `createEvent`
  takes it as a required argument and always writes it (`false` for production, never absent), and an envelope
  without it fails `parseEvent` (a consumer sends it to the dead-letter path, never treats it as production).
  Nothing in a schema, controller or service defaults an environment: no `.default()` and no `??`/`||`
  fallback for `environment`, `sandbox` or `sbx` (a scan test pins it). The auth context's `sandbox` is always a
  defined boolean, set from the verified token's `sbx` claim; the realtime ticket keeps it (D-30), and the ticket
  redeem answer carries `sandbox`. Where an operator names an environment (issue a credential, register a reward
  API, the internal balance read) it is a required request field. Only the producing service sets it, from server-side state (the
  verified integration credential, token claim `sbx`), never from client input or a payload field. Metering
  and billing read the envelope flag and nothing else. `audit.acting_request` is the one cross-service event
  name that does not follow `<owning-service>.<aggregate>.<past-tense-verb>`, because every service writes it.
- **pinned:** `packages/contracts/src/events.contracts.test.ts`

## Error body and code casing

- **provider:** `packages/contracts` (`src/http.ts`, `ErrorBody.code?`) · **consumers:** every client
- **spec:** `{ message, code?, issues? }`. Errors raised by the service-kit auth entry point use identity's
  `UPPER_SNAKE` codes (for example `TOKEN_EXPIRED`); route errors use the owning service's own
  `lower_snake` codes. Clients branch on the HTTP status first, then on the code.
- **pinned:** `packages/contracts/src/events.contracts.test.ts` (ErrorBody keeps `code`)

## Contract owners (reconciled, D-9 / D-12)

- `events.ts` envelope: foundation. Each service owns its own registry rows. `identity.ts`,
  `service-kit/src/testing/*`: identity. `payments.ts` (coin events, reserve API, `COIN_VALUE_ACTIONS`):
  payments. `ingest.ts`, `casino-adapter.ts`, `spin.completed`: engagement ingest. `store.ts`: engagement
  store (adopts payments' names and codes). `web-api.ts`: web. Other services import these and never redefine
  them. `PAYMENTS_INTERNAL_ROUTES` is declared once, in `identity.ts`, next to the service-call allow-list.

## Tenant context and isolation

- **provider:** `packages/tenancy` · **consumers:** every service
- **spec:** the tenant is carried in an async-local context; `Db.tenantTx` runs `SET LOCAL app.tenant_id`;
  tenant tables carry `ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy on `tenant_id`; no tenant means no
  rows and no writes. A route without a tenant must be marked `@Public()`.
- **pinned:** `packages/tenancy/src/tenancy.test.ts`; `tests/compose/src/tenancy.compose.test.ts` (the
  service role itself reads nothing without a tenant)

## Outbox and inbox (delivery)

- **provider:** `packages/bus` · **consumers:** every service that publishes or consumes
- **spec:** a published event is first an `outbox` row written in the business transaction; the relay
  publishes with confirms (mandatory) and marks it done. A consumer inserts `(consumer, event_id)` into
  `inbox` in the same transaction as the effect; a conflict means already applied. Invalid or failing
  messages are rejected without requeue into `<service>.dlq`. Topology: exchange `mio.events` (topic, routing
  key = event type), dead-letter exchange `mio.events.dlx`.
- **pinned:** `packages/bus/src/bus.test.ts`; `tests/compose/src/bus.compose.test.ts`

## Idempotency

- **provider:** `packages/idempotency` · **consumers:** `payments` (and any future retried write)
- **spec:** scope = tenant + principal + operation + `Idempotency-Key`; the canonical request hash detects a
  changed body (422); a concurrent attempt is 409; the stored response is written in the effect's
  transaction.
- **pinned:** `packages/idempotency/src/idempotency.test.ts`; `tests/compose/src/tenancy.compose.test.ts`

## Casino ingestion and the adapter interface

- **provider:** `apps/engagement` (`src/integrations`), schemas in `packages/contracts` (`src/ingest.ts`) ·
  **consumers:** casino platforms (inbound webhooks), `apps/casino-sim`, the rules, wheel and store code
  (canonical types only)
- **spec:** `docs/specs/engagement-ingest.md`. `POST /v1/integrations/{tenantSlug}/events`: the casino's own
  signature (D-15 Q-1) verified in the engagement adapters with the secrets that identity serves to
  `svc:engagement` (`TenantIntegration`), then schema, the player resolved to an internal id through identity,
  then one transaction for the `UNIQUE (tenant_id, source, external_event_id)` row and the
  `engagement.deposit.confirmed` outbox message, which carries `player_id` only, never the raw casino id (X-1).
  The adapter's port is the one in `casino-adapter.ts`, and `sandbox` on the envelope comes from the verified
  integration credential (X-3, D-13).
  A duplicate returns 200 with the first body. Money is an integer in minor units. Each adapter declares a
  recovery mode (`native_lookup` or `idempotent_replay`) so a lost reward reply is recoverable by our key.
  **Reward API URL (D-30, F1).** `PutRewardApiRequest.base_url` refuses credentials and literal loopback,
  private, link-local, unspecified and metadata addresses (`packages/contracts/src/ip-guard.ts`). The
  engagement transport (`fetchTransport`) resolves the host at call time, connects only to an address that
  passed the same check, never follows a redirect (any 3xx is an unknown outcome), and requires `https`
  when `NODE_ENV=production`. Identity's PUT service also refuses a plain-http `base_url` for the
  `production` environment (`VALIDATION_FAILED`); the sandbox endpoint may be http. Hosts in the
  `REWARD_API_ALLOW_HOSTS` env var (comma separated; read by both identity and engagement; compose:
  `casino-sim`) are exempt from the https rule, and engagement's transport also exempts them from the
  address rule. The casino's rejection reason is truncated to 64 characters and limited to
  `[A-Za-z0-9_.:-]` (anything else becomes `_`) before it is stored.
  **Spin Idempotency-Key.** `scopedKey` throws `ScopedKeyTooLong` when escaping pushes a key past 512
  characters; the spin service maps it to 422, never 500.
- **pinned:** `packages/contracts/src/ingest.contracts.test.ts`,
  `apps/engagement/src/integrations/adapters.contract.test.ts`,
  `apps/engagement/src/controllers/ingest.controller.test.ts`,
  `tests/compose/src/ingest.compose.test.ts`

## Spin and reward table

- **provider:** `apps/engagement` · **consumers:** `web` (player widget), `payments` (via
  `engagement.spin.completed`; key `spin:{spin_id}`)
- **spec:** `docs/specs/engagement-ingest.md` section 8. A spin consumes one credit with a single
  conditional UPDATE; the outcome is `HMAC(server_seed[version], spin_id)` against a versioned weight
  table; the request body carries nothing that can steer the outcome; the player view has no weights.
- **pinned:** `apps/engagement/src/services/wheel.test.ts`, `services/spin.service.test.ts`,
  `controllers/spin.controller.test.ts`, `tests/compose/src/ingest.compose.test.ts`

## Redemption saga

- **provider:** `apps/engagement` (store module), `docs/specs/engagement-store.md` · **consumers:** `web`
- **spec:** the saga is a client of two contracts it does not own and does not redefine (X-17): the coin reserve is
  payments' (see "Coin commands, balance read and coin events", L2, routes `PAYMENTS_INTERNAL_ROUTES`, rejection
  codes `PaymentsErrorCode`), and the casino reward port is the ingest area's (see "Casino ingestion and the
  adapter interface", L3, `casino-adapter.ts`).
- **pinned:** `packages/contracts/src/store.contracts.test.ts`;
  `apps/engagement/src/services/redemption-saga.test.ts`

## Health endpoints

- **provider:** `packages/service-kit` (`src/health.ts`) · **consumers:** compose, the deploy plane
- **spec:** `GET /healthz/live` is 200 while the process runs and consults nothing; `GET /healthz/ready` is
  200 only when every dependency answers, else 503 with the same body shape (`HealthCheck`).
- **pinned:** `tests/compose/src/health.compose.test.ts`

## Database migrations entry point

- **provider:** each service (`dist/migrate.js`, built from `src/migrate.ts`) · **consumers:** compose, the
  deploy plane
- **spec:** `node dist/migrate.js` applies pending migrations and exits 0, or exits 1 on failure with the
  reason on stderr. The runtime image has no pnpm and no TypeORM CLI. The app never migrates on boot.
  It also exits 1 when the image ships NO migrations (a missing `dist/model/migrations`) and when any
  shipped migration is still pending after the run: the applied set must equal the shipped set, and the
  shipped set must not be empty. Each service Dockerfile fails the build if `dist/model/migrations/*.js`
  or `dist/migrate.js` is absent.
- **deploy:** Deckhand runs `migrations.run` with `/bin/sh -lc` in a runtime container with no checkout, so
  `.deckhand/deploy.yml` runs `docker run <prefix>/<service>:<tag> node dist/migrate.js` inline per service
  (identity, engagement, payments), never a repo script.
- **pinned:** `packages/service-kit/src/postgres.test.ts` (options), `review-final-starter.test.ts`
  (STARTER-7, STARTER-8a/b/c), compose start (`migrate && start`)

## Realtime reconnect resync

- **provider:** `apps/web` `WSProvider` · **consumers:** every page that shows pushed state
- **spec:** connection-state recovery is off on the server and there is no `(epoch, id)` replay cursor
  (D-10), so pushes sent while the socket was down are lost. After a reconnect (every `connect` after the
  first) the client invalidates and refetches all active queries over REST. The first connect does not.
- **pinned:** `apps/web/src/layers/app/providers/review-final-resync.test.tsx` (RESYNC-1)

## Log and product-event redaction

- **provider:** `packages/logger` (`redact.ts`), `packages/contracts` (`ProductEventProps`) · **consumers:**
  every service
- **spec:** allow-lists. A log key outside the list keeps its name and loses its value (nested leaves are
  censored as `[redacted]`); strings that pass are scrubbed for bearer tokens, `key: value` secrets, URL
  query/fragment, JWTs and emails. Product-event prop text must use a closed character set. See
  `docs/observability/redaction.md` and `docs/analytics.md`.
- **pinned:** `packages/logger/src/review-final-redaction.test.ts` (REDACT-_, PROPS-_)

## Identity token and tenant claim

- **provider:** `identity` (issues), `packages/service-kit` (`auth.ts`, verifies), `packages/tenancy`
  (`jwtTenantResolver`) · **consumers:** every service, `web`
- **spec:** `docs/specs/identity.md`; claims in `packages/contracts/src/identity.ts`. RS256, `aud` is one service,
  TTL at most 900 s, keys at `/.well-known/jwks.json`. The tenant of a request is the verified `tid` (or
  `act.tenant_id` on a platform admin acting session) and nothing else.
- **pinned:** `packages/service-kit/src/auth.test.ts`, `apps/identity/src/identity.*.test.ts`,
  `tests/compose/src/identity.compose.test.ts`

## Postgres TLS

- **provider:** `packages/service-kit` (`resolvePostgresSslMode`) · **consumers:** every service
- **spec:** `DATABASE_SSL=disable|require|verify-full`. Off by default outside production; in production it
  must be stated, so TLS is never off by accident. A self-hosted database without TLS sets `disable`
  explicitly. `sslmode` in the URL is honoured only when `DATABASE_SSL` is unset.
- **pinned:** `packages/service-kit/src/postgres.test.ts`

## Product analytics line

- **provider:** `packages/logger` (`logProductEvent`) · **consumers:** the log collector that tails stdout
- **spec:** one JSON object per line with `kind: "product_event"`, in Varta's closed envelope (D-19):
  `event` as `domain.object_action`, `event_v`, a UUIDv7 `event_id`, a mandatory `tenant_id`, exactly one
  of `actor_id` and `anon_id`, `consent`, flat scalar `props` with no PII-shaped key, at most 8 KiB.
  The schema is vendored at `packages/contracts/schemas/varta-product-event.schema.json` (source commit
  beside it). The catalogue and the funnels are in `docs/analytics.md`.
- **pinned:** `packages/logger/src/product-event.test.ts` (ajv against the vendored schema), and one
  `analytics.test.ts` per emitting service (identity, payments, engagement, web BFF)

## Coin commands, balance read and coin events

- **provider:** `payments` (`packages/contracts/src/payments.ts`) · **consumers:** `engagement` (commands),
  `web` and any service (balance read), any subscriber of `payments.coins.*`
- **spec:** `docs/specs/payments.md`. Only `payments` changes a balance; `reserve`, `capture`,
  `release`, `refund` are internal routes for the `engagement` service identity, each idempotent on its own
  key and by the state of the reserve. There is no credit route: spin coins arrive by consuming
  `engagement.spin.completed` (decision D-1). Rejection codes `reserve_already_captured|released|refunded`,
  `reserve_not_captured`, `reserve_not_found`, `insufficient_funds` are payments' (L4 adopts them). Amounts are integers `1..1_000_000_000_000`. Events
  `payments.coins.credited|reserved|captured|released|refunded` v1 are written in the effect's transaction.
- **pinned:** `packages/contracts/src/payments.contracts.test.ts`, `apps/payments/src/controllers/coins.controller.test.ts`,
  `apps/payments/src/**/*.pgtest.ts`
