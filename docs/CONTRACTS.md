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

## Event envelope and event types

- **provider:** `packages/contracts` (`src/events.ts`) · **consumers:** every service that publishes or
  consumes events
- **spec:** `{ event_id (uuidv7), type, version, tenant_id, occurred_at, correlation_id, causation_id,
payload }`; `tenant_id` is mandatory; the payload schema is registered per (type, version); an unknown type
  or version is rejected.
- **pinned:** `packages/contracts/src/events.contracts.test.ts`

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

## Redemption saga: the coin reserve (payments, synchronous)

- **provider:** the payments service (`POST /internal/v1/coins/reserve|capture|release|refund`, schemas in its
  contracts), semantics in `docs/specs/engagement-store.md` · **consumers:** `engagement` (the redemption saga)
- **spec:** the saga calls the four routes with the service identity and `Idempotency-Key` `hold:{id}`,
  `capture:{id}`, `release:{id}`, `refund:{id}`; `reserve_id` is the redemption id. `409 insufficient_funds` on the
  reserve is returned to the player as 409. Capture, release and refund are idempotent by the state of the reserve;
  a conflicting transition is `409 invalid_reserve_transition`. A timeout is retried with the same key by the
  sweeper. The store registers no hold command and no hold event; it consumes none of the payments coin events.
- **pinned:** `packages/contracts/src/store.contracts.test.ts` (nothing re-registered);
  `apps/engagement/src/services/redemption-saga.test.ts` (against a fake of the HTTP table)

## Casino reward adapter port

- **provider:** `packages/contracts` (`casino-adapter.ts`, `CasinoRewardPort`), owned by the integrations module ·
  **consumers:** `engagement` (redemption saga)
- **spec:** `issueReward(request, key)` and `getRewardStatus(key, request)` take OUR idempotency key
  `redeem:{redemption_id}`, identical on every attempt, and the frozen request; issue answers `issued`, `pending`,
  `rejected` or `unknown`; the lookup answers `issued`, `pending`, `rejected`, `not_found` or `unknown`. A refund of
  coins is allowed only after `rejected`; never after `unknown`.
- **pinned:** `apps/engagement/src/services/redemption-saga.test.ts` (saga side); adapter side: the integrations
  module's contract tests

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
- **pinned:** `packages/service-kit/src/postgres.test.ts` (options), compose start (`migrate && start`)

## Postgres TLS

- **provider:** `packages/service-kit` (`resolvePostgresSslMode`) · **consumers:** every service
- **spec:** `DATABASE_SSL=disable|require|verify-full`. Off by default outside production; in production it
  must be stated, so TLS is never off by accident. A self-hosted database without TLS sets `disable`
  explicitly. `sslmode` in the URL is honoured only when `DATABASE_SSL` is unset.
- **pinned:** `packages/service-kit/src/postgres.test.ts`

## Product analytics line

- **provider:** `packages/logger` (`logProductEvent`) · **consumers:** the log collector that tails stdout
- **spec:** one JSON object per line with `kind: "product_event"`, a snake_case `event`, and a mandatory
  `tenant_id`. Secrets are redacted.
- **pinned:** `packages/logger/src/product-event.test.ts`
