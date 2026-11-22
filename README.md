# MIO Games (ex-mio-games)

A working vertical slice of a multi-tenant engagement platform for online casinos. A casino sends a signed
deposit event, the player earns a Wheel of Fortune spin, spins it for a server-decided coin reward, and redeems
coins for a Bonus Store reward that MIO Games asks the casino to issue. Two simulated casinos with different
event and reward APIs run through the same internal logic. Operators run it from a console.

The repository is a monorepo of small services, built from the monorepo starter and extended with tenancy, an
event bus and idempotent money handling. For the product and the decisions behind it start at
[`AGENTS.md`](AGENTS.md) and [`docs/README.md`](docs/README.md). Status words used everywhere: **Built**,
**Partial** (the core exists, the named part does not) and **Next** (decided, not built).

## Run it from a clean clone

You need Docker with compose v2. No account of any kind is needed: identity runs on the Firebase Auth Emulator,
the casinos are simulated, billing uses a fake payment provider. The first build downloads base images and
packages, so it needs network access once.

```sh
git clone <repository-url> ex-mio-games
cd ex-mio-games
docker compose up -d --wait      # builds the images, starts nine containers, returns when all are healthy
```

There is no `.env` file to create: every variable has a local-development default in `docker-compose.yml`.
The `tools/archify` submodule is only the diagram renderer; `docker compose` does not need it, so a plain clone
is enough (use `git clone --recurse-submodules` only to re-render the diagrams).

<!-- OUTPUT: `docker compose up -d --wait` (build time, and the final list of nine healthy containers) -->

<!-- OUTPUT: `docker compose ps` (service, status, ports) -->

Check that every service answers (liveness, then readiness, which also checks its dependencies):

```sh
for p in 4001 4002 4003 4004; do curl -s localhost:$p/healthz/ready; echo; done
```

<!-- OUTPUT: the four readiness responses -->

Stop and delete the data with `docker compose down -v`.

### Try the 8-step workflow

The first two steps by hand. The tenant comes from the `Host` header (`<slug>.mio.localhost`), never from the
body.

```sh
# sign up an operator: creates the tenant and its first admin
curl -s -X POST localhost:4001/v1/operators/signup \
  -H 'content-type: application/json' \
  -d '{"tenant_name":"Acme Casino","slug":"acme","email":"boss@acme.test","password":"correct horse battery"}'

# sign in
curl -s -X POST localhost:4001/v1/auth/login \
  -H 'content-type: application/json' -H 'host: acme.mio.localhost' \
  -d '{"email":"boss@acme.test","password":"correct horse battery","audience":"engagement"}'

# engagement received the tenant event over RabbitMQ and built its own copy
curl -s localhost:4002/v1/tenant-projection -H 'authorization: Bearer <access_token>'
```

The rest of the workflow (a signed deposit from casino A and from casino B, the spin, the balance, the Bonus
Store, the redemption and its final status, then the idempotent replay, the bad-signature and the cross-tenant
cases) is one request per file in [`docs/samples/`](docs/samples/), in the `.http` format. The responses in
those files are expected shapes from the contracts, not recorded output. The recorded output of one full run
goes here:

<!-- OUTPUT: workflow step 1-3, deposit from casino A (request and response) -->
<!-- OUTPUT: workflow step 1-3, deposit from casino B (request and response) -->
<!-- OUTPUT: workflow step 4-5, spin and balance -->
<!-- OUTPUT: workflow step 6-8, redemption and its final status (ISSUED, then COMPLETED) -->
<!-- OUTPUT: Part C cases: duplicate deposit, bad signature 401, cross-tenant 404 -->

## Service map, ports and environment

| Container       | Host port          | Owns                                                                                          |
| --------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `web`           | 3000               | Next.js app: player widget and operator console, a BFF in front of the services               |
| `identity`      | 4001               | tenants, users, tokens and JWKS, player mapping, integration credentials, audit (own database) |
| `engagement`    | 4002               | casino ingest and adapters, rules, wheel and spins, Bonus Store, redemption saga, the `/rt` Socket.IO gateway (own database) |
| `payments`      | 4003               | the only place coins change: ledger, reserves, reconciliation, plan billing (own database)    |
| `casino-sim`    | 4004               | two simulated casinos with fault injection (`SIM_FAULTS=1` in compose)                        |
| `postgres`      | 54329              | one database and one non-superuser app role per service, plus an owner role for migrations    |
| `rabbitmq`      | 55672, UI on 15672 | event bus (outbox and inbox in every service)                                                 |
| `redis`         | 56379              | append-only persistence; an optional balance projection and a health probe                    |
| `firebase-auth` | 9099               | Firebase Auth Emulator, project `demo-ex-mio`                                                 |

How the services talk: services publish events over RabbitMQ through a transactional outbox and consume them
through an idempotent inbox. Two calls are synchronous: the coin reserve for a redemption (engagement to
payments) and service-token and credential lookups (to identity). Every service trusts only tokens identity
signed (RS256, keys at `/.well-known/jwks.json`). The tenant comes from the verified `tid` claim; no header names
a tenant. Payments has no credit route: coins arrive only from `engagement.spin.completed` events.

Infrastructure ports are not the defaults, so a database already running on your machine does not collide.
Override any host port with the variable named in `docker-compose.yml` (`POSTGRES_PORT`, `RABBITMQ_PORT`,
`REDIS_PORT`, `WEB_PORT`, `IDENTITY_PORT`, `CASINO_SIM_PORT`, ...).

Main variables (all have a working default in compose; the values there are for local development only):

| Variable                                   | Service            | Meaning                                                              |
| ------------------------------------------ | ------------------ | -------------------------------------------------------------------- |
| `DATABASE_URL`                             | every service      | runtime connection as `<service>_app` (not the owner, no DDL)        |
| `MIGRATION_DATABASE_URL`                   | every service      | connection as `<service>_owner`, used by `node dist/migrate.js` only |
| `IDENTITY_URL`                             | engagement, payments | where tokens and keys are verified                                 |
| `SERVICE_CLIENT_SECRET`                    | engagement, payments | this service's client secret for service tokens                    |
| `SERVICE_CLIENT_SECRETS`                   | identity           | the registry of service client secrets                               |
| `CREDENTIALS_KEK`                          | identity           | key that encrypts casino integration secrets                         |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | identity    | the platform admin                                                   |
| `IDENTITY_PROVIDER`                        | identity           | `firebase-emulator` (default) or `fake` (tests only)                 |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FIREBASE_PROJECT` | identity    | the emulator address and project                                     |
| `BASE_DOMAIN`                              | identity           | tenants resolve from `<slug>.<BASE_DOMAIN>` (`mio.localhost`)        |
| `REDIS_URL`                                | engagement, payments | optional; payments uses it for the balance projection              |
| `PAYMENTS_URL`                             | engagement         | where the coin reserve is called                                     |
| `FAKE_PROVIDER_WEBHOOK_SECRET`             | payments           | billing webhook secret; required in production unless Stripe is set  |
| `STRIPE_SECRET_KEY`                        | payments           | selects the Stripe stub, which throws on every call                  |
| `LEDGER_JOBS_INTERVAL_SECONDS`             | payments           | interval of the reconciliation and usage-report jobs                 |
| `DATABASE_SSL`                             | every service      | `disable`, `require` or `verify-full`; stated explicitly in production |
| `API_URL`                                  | web                | server-side URL of identity inside the compose network               |
| `REALTIME_UPSTREAM`                        | web (build time)   | where `/socket.io/*` is proxied (default `http://engagement:4002`)   |
| `REALTIME_ALLOWED_ORIGINS`                 | engagement         | comma-separated origins that may open a socket cross-origin          |
| `SIM_FAULTS`                               | casino-sim         | `1` turns on fault injection                                         |

Each service applies its own migrations (`node dist/migrate.js`) before it serves, and starts only after what it
needs reports healthy. Probes: `GET /healthz/live` (the process is up) and `GET /healthz/ready` (dependencies
answer, 503 otherwise).

### Realtime

Engagement hosts the Socket.IO gateway (namespace `/rt`). The browser never talks to it directly: the web app
proxies `/socket.io/*` to engagement, so the socket opens on the web origin. The socket authenticates with a
one-time ticket (`aud=realtime`, at most 60 s) from `GET /api/realtime/ticket`. Delivery is at most once and
there is no replay of events missed while disconnected: the client resyncs over REST after a reconnect. For
`next dev` outside compose run `REALTIME_UPSTREAM=http://localhost:4002 pnpm --filter @ex-mio/web dev`.

## Tests

You need Node 24 and pnpm 9 for everything below (`pnpm install --frozen-lockfile` first). Every heavy command
can be run for one project with `pnpm nx run <project>:<target>`.

| Suite                                  | Command                                                         | Needs                       |
| -------------------------------------- | --------------------------------------------------------------- | --------------------------- |
| All unit and contract tests            | `pnpm test` (nx, every project)                                 | nothing running             |
| One service or package                 | `pnpm --filter @ex-mio/<name> test` (identity, engagement, payments, contracts, service-kit, bus, tenancy, idempotency, logger, casino-sim) | nothing running |
| Web                                    | `pnpm --filter @ex-mio/web test` (vitest)                       | nothing running             |
| Design system, contrast and colour gate | `pnpm --filter @ex-mio/ui test`                                | nothing running             |
| Payments against Postgres              | `pnpm --filter @ex-mio/payments test:db`                        | `docker compose up -d --wait postgres` |
| Engagement store against Postgres      | `pnpm --filter @ex-mio/engagement test:pg`                      | `docker compose up -d --wait postgres` |
| Whole stack: health, roles, tenant isolation, idempotency, bus, ingest, saga, audit | `pnpm test:compose` | `docker compose up -d --wait` (the stack on its default ports) |
| Lint (layering, package boundaries)    | `pnpm lint`                                                     | nothing running             |
| Typecheck                              | `pnpm typecheck`                                                | nothing running             |
| Frontend layering                      | `pnpm lint:fsd`                                                 | nothing running             |
| Design system in a browser             | `pnpm storybook` (port 6006)                                    | nothing running             |

<!-- OUTPUT: `pnpm test` (per-project pass counts) -->
<!-- OUTPUT: `pnpm --filter @ex-mio/payments test:db` and `pnpm --filter @ex-mio/engagement test:pg` -->
<!-- OUTPUT: `pnpm test:compose` (suite and test counts against the running stack) -->
<!-- OUTPUT: `pnpm lint` and `pnpm typecheck` -->

Money paths are tested with concurrency (parallel spins and reservations, parallel same-key requests), with a
kill at each durable step of the redemption, and with a one-million-spin distribution check. The map from each
reliability case to its tests is in [`docs/submission/part-c.md`](docs/submission/part-c.md). Only one compose
stack can run on a machine at a time (the host ports are fixed). Run `docker compose down -v` before starting a
second one.

## Assumptions

- Both casinos are simulated. They use two different wire protocols: casino A signs headers with a timestamp and
  can look up a reward by our key; casino B signs inside the body and has no lookup by key, so recovery replays
  the same request with the same key. No real casino API is called.
- The operator's plan billing runs against a fake payment provider (test cards only). The Stripe provider is a
  stub that throws until implemented.
- Identity uses the Firebase Auth Emulator with one provider tenant per MIO tenant, so the same email can register
  in two tenants. Players do not have provider accounts: a player is the casino's launch token plus our mapping.
- Coins are virtual, whole numbers, with no cash value. Amounts from casinos are integers in minor units; a float
  is rejected.
- A deposit grants spins by a per-tenant rule; the demo rule is "a deposit of at least 20.00 grants one spin".
- Rules, reward tables and store items are tenant configuration, and odds changes are versioned. Publishing a new
  rule or wheel version has no API route yet; the console answers those calls from its mock adapter.
- The coin credit for a spin travels by event, so a balance read is eventually consistent for a moment after a
  spin. Money commands read Postgres.
- Access tokens last 15 minutes. Refresh tokens are not built.
- A sandbox integration credential is separate from a production one: sandbox events use separate sandbox wallets
  and spin credits and are not metered.
- No independent RNG certification and no production infrastructure. All credentials in the repository are
  local-development values.

## What is built, partial and next

Checked against the code. The full table with the reasons is section 14 of
[`docs/architecture/overview.md`](docs/architecture/overview.md#14-built-versus-designed).

| Area                                                                                         | Status                                                    |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Five services, one container and one database each, one compose file                         | Built                                                     |
| Tenancy: token claim, row-level security, separate owner and app roles, isolation tests      | Built                                                     |
| Two casino adapters, canonical model, adapter contract suite, simulator with fault injection | Built                                                     |
| Signed event ingestion, validation, deduplication, outbox and inbox, dead-letter replay      | Built                                                     |
| Rules engine, versioned reward table, server-side deterministic wheel                        | Built                                                     |
| Double-entry coin ledger, reserve, capture, release, refund, reconciliation job              | Built (reports a mismatch, no pager)                      |
| Bonus Store, redemption saga with recovery from unknown outcomes, operator review route      | Built                                                     |
| Identity: tokens, JWKS, RBAC, acting sessions with audit, service tokens, launch exchange    | Built                                                     |
| Operator signup and plan checkout against the fake provider                                  | Built                                                     |
| Realtime push over Socket.IO with a one-time ticket                                          | Built, at most once                                       |
| Web: player widget and operator console                                                      | Built, minimal; rules and wheel publishing are mocked (see known gaps) |
| Product events for Varta                                                                     | Partial: contract and logger function, no service emits yet |
| Redis balance projection                                                                     | Partial: wired, optional, off in default compose          |
| Missed-event replay on websocket reconnect                                                   | Next                                                      |
| Rate limiting                                                                                | Next                                                      |
| Stripe payment provider                                                                      | Next (interface and a stub that throws)                   |
| Production identity provider, refresh tokens                                                 | Next                                                      |
| Provably-fair seed commitment, RNG certification                                             | Next                                                      |
| Per-service deployment secrets                                                               | Next, not claimed                                         |
| Deckhand deploy and Varta wiring                                                             | Described, not run here                                   |

## Where the answers are

| Part                                       | Answer                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A: architecture                            | [`docs/architecture/`](docs/architecture/README.md) (diagrams), [`overview.md`](docs/architecture/overview.md), [`docs/adrs/`](docs/adrs/) |
| B: working prototype                       | this README, the flows in [`docs/samples/`](docs/samples/), the service specs in [`docs/specs/`](docs/specs/)                                |
| C: reliability and security                | [`docs/submission/part-c.md`](docs/submission/part-c.md) and the reliability matrix in the overview                                          |
| D: AI-native development                   | [`docs/ai/`](docs/ai/README.md): process, decisions, defects found, verification                                                            |
| E: scaling, first 90 days, team            | [`docs/scaling/`](docs/scaling/README.md) and [`90-days.md`](docs/scaling/90-days.md)                                                       |
| What is missing                            | [`docs/submission/known-gaps.md`](docs/submission/known-gaps.md)                                                                            |
| The backlog (17 epics, tasks, acceptance)  | [`backlog/`](backlog/README.md)                                                                                                             |

## Known limitations

- The websocket has no missed-event replay; the client resyncs over REST.
- Stripe exists only as an interface; the production identity provider is not chosen; there are no refresh tokens.
- Deckhand deploy and Varta wiring are described, not run here.
- There is no rate limiting.
- The wheel's tenant rule cap (`max_grants_per_player`) is best effort when two deposits of one player are
  processed in parallel; only the sequential case is pinned.
- A casino that cannot look up a reward by our key and has no idempotent replay leaves the redemption in operator
  review; the operator's word alone never moves coins.
- The reconciliation job reports mismatches and never repairs them.
- Erasure removes the player-to-wallet link; whether the pseudonymous player id must also be erased from events
  already consumed is an open question.
- Postgres TLS is explicit in production: set `DATABASE_SSL` to `disable`, `require` or `verify-full`. Identity
  refuses to start in production with a development `CREDENTIALS_KEK` or `PLATFORM_ADMIN_PASSWORD` or with the
  `fake` identity provider. Migrations are a separate step (`scripts/migrate-all.sh`, which the manifest
  `.deckhand/deploy.yml` points at).

The full list, with the web calls that no service answers yet, is in
[`docs/submission/known-gaps.md`](docs/submission/known-gaps.md).

## Operations

Each service has two database roles: `<service>_owner` (owns the schema, used by `migrate.js` only) and
`<service>_app` (runtime: not the owner, no DDL, exact grants listed in the `AppRoleGrants` migration).
Dead-lettered messages wait in `<service>.dlq`; after fixing the cause, re-drive them with
`node dist/dlq-replay.js [--dry-run] [--limit N] [--outbox]` in that service's container. Payments' worker
reconciles every tenant's ledger and reports usage on an interval; `pnpm --filter @ex-mio/payments ledger:report`
(`node dist/ledger-report.js`) runs one pass by hand and exits 1 on a mismatch.

## Next steps

1. Fill the recorded outputs in this README from one full run of the stack.
2. Authenticated journal replay for realtime, and a Redis adapter for more than one engagement instance.
3. Provably-fair draws: publish a hash of the seed before play, reveal after rotation.
4. Stripe provider and hosted checkout; entitlements by plan. Refresh tokens and a production identity provider.
5. Rate limits per tenant; emit product events from the services; alerts on reconciliation and dead-letter depth.
6. API routes for publishing rules and wheel versions, so the console stops answering them from its mock.
7. Per-service deployment secrets and the blue-green rollout through Deckhand; observability through Varta.
8. Move integrations into their own service when a second operator team needs independent releases.

## How this was built

Planned and built with AI coding agents under a review framework (review-framework) that requires a regression
test at the choke point and a re-applied mutation for every claimed fix. The service skeleton comes from the
monorepo starter. Evidence, and the decisions made by hand, are in [`docs/ai/`](docs/ai/README.md).

## License

MIT, see [`LICENSE`](LICENSE).
