# System patterns

The patterns the code follows. Each links to the code that implements it; the boundary semantics are in
`docs/CONTRACTS.md`.

## Layout

```
apps/identity | engagement | payments   NestJS on Fastify, own database, own migrations
apps/casino-sim                         two fake partner casinos with fault injection
apps/web                                Next.js, feature-sliced (src/layers/*)
packages/contracts                      zod: HTTP DTOs, event envelope, event types, health
packages/tenancy                        tenant context, guard, transaction helper, RLS helper, cache keys
packages/bus                            outbox + relay, inbox consumer, topology, dead letters
packages/idempotency                    at-most-once effect per key
packages/service-kit                    bootstrap, config, Postgres TLS, migrations CLI, health, Db
packages/logger                         pino JSON; product events
packages/ui                             CSS-variable tokens, base components, Storybook
tests/compose                           tests that run against the live compose stack
```

## Service layering (MVC), enforced by lint

`controllers/` -> `services/` -> `model/`. Dependencies point one way only.

- **Controller**: validates every input (body, params, query, headers) with a zod schema from
  `@ex-mio/contracts` through `parseInput`, calls a service, shapes the response. No data access.
- **Service**: application logic only. Gets a transaction from `Db`, passes it to repositories. No HTTP, no
  driver imports.
- **Model**: entities, repositories, migrations. Everything about data and nothing about HTTP or logic.

Eslint (`.eslintrc.mvc.cjs`) rejects an import that goes the wrong way. Between packages, Nx tags
(`type:app|lib|test`, `scope:*`) restrict who may depend on whom; a service never imports another service.

## Tenancy (fails closed)

- The tenant comes from the request (today a header; the identity service will issue a token whose verified
  claim replaces it) and is held in an async-local context.
- `TenantGuard` denies by default; `@Public()` marks the few tenant-less routes (health, platform admin).
- `Db.tenantTx` opens a transaction with `SET LOCAL app.tenant_id`. No tenant in context: it throws before
  any query.
- Every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy on `tenant_id` (see
  `enableTenantRls`). With no tenant set, reads return nothing and writes are refused. The service roles are
  not superusers and do not bypass RLS.
- Cache keys are built with `tenantCacheKey`; a bare key is a bug.

## Events

- Envelope: `event_id` (uuidv7), `type`, `version`, `tenant_id`, `occurred_at`, `correlation_id`,
  `causation_id`, `payload`. Types are registered with a zod payload per version in `contracts`.
- **Publish**: write the event to the `outbox` table in the same transaction as the business change
  (`Db.publish`). A relay publishes with confirms and marks the row done; an unroutable message stays and is
  retried. Delivery is at least once.
- **Consume**: the inbox row `(consumer, event_id)` and the effect commit in one transaction; a conflict
  means the event was already applied, so it is acknowledged and dropped. A message that is invalid or whose
  handler throws is rejected without requeue and lands in `<service>.dlq`.

## Idempotency

A retried request with the same `Idempotency-Key` runs its effect once. Scope is tenant, principal,
operation and key; the canonical request hash detects a changed body (422); a concurrent attempt gets 409.
The stored response is written in the same transaction as the effect.

## Money

Balances are read from anywhere; they change only through `payments`. A ledger entry is written together with
its event, never separately. Every guard on a money path has a test that fails when the guard is removed.

## Configuration, database, migrations

- Config is parsed with zod at boot and fails with the full list of problems.
- Postgres TLS is explicit: `DATABASE_SSL=disable|require|verify-full`. Off by default locally; in
  production it must be stated (a database without TLS says `disable`).
- `synchronize` and `migrationsRun` are off everywhere. Migrations run as `node dist/migrate.js` (exit 0
  applied, 1 failed): the runtime image has no pnpm and no TypeORM CLI.
- Workers and entry points that read a `.env` file load it with `import 'dotenv/config'`.

## Logging and analytics

`createLogger` writes one JSON object per line to stdout. Product events use `logProductEvent` from a service,
with `kind: "product_event"` and a mandatory `tenant_id`. Secrets and tokens are redacted by the logger.

## Frontend

Feature-sliced layers (`app > views > widgets > features > entities > shared`), imports flow downward only
(lint + Steiger). Components come from `@ex-mio/ui`; styling reads CSS variables from its tokens.
