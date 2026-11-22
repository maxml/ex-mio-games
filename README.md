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

### The web app (live by default)

The web app at `http://localhost:3000` runs **live**: the image is built with `NEXT_PUBLIC_MIO_API=http` and its
BFF calls identity (4001), engagement (4002) and payments (4003) over the compose network, so the operator
console and the player widget show what the services return. Screenshots of both are in
[`docs/screens/`](docs/screens/README.md) (`*-live.png`).

Mock mode stays available explicitly, for screenshots and Storybook: `MIO_API=mock docker compose up -d --build web`.
`NEXT_PUBLIC_MIO_API` is inlined at build time, so rebuild the image to switch.

Try it:

1. Open `http://localhost:3000/en/operator`. Sign up (the tenant slug is the company name, lower case with
   dashes), pay a plan with the pre-filled test card, create the sandbox credentials (the secrets are shown
   once: copy the key id and the HMAC secret), save rules, publish a wheel, add a Bonus Store item. These call
   identity, payments and engagement for real. In compose the web app plays the payment provider's callback
   itself, because the fake provider sends none.
2. Play the casino: `scripts/web-live-player.sh <slug> <email> <password> <key id> <hmac secret>` registers the
   casino reward API, sends signed deposits for a player and prints the widget URL with a signed launch token.
   Open it within 2 minutes: spin, open the Bonus Store, redeem, and watch the status go Pending, then Issued.
3. A few calls have no service endpoint and stay answered by the in-memory mock for that call only: the sandbox
   check, go-live and the first live deposit, the coin history, the cross-tenant admin tables, the per-day usage
   chart. They are listed, with what is missing, in [`docs/submission/known-gaps.md`](docs/submission/known-gaps.md).

Captured on a clean machine state (project name `demo`, images built beforehand). The image builds took
about 4 to 5 minutes per group of services here, and are mostly the one `pnpm install`; `up --wait` itself took 1 minute:

```text
$ docker compose up -d --wait
 Container demo-rabbitmq-1 Healthy
 Container demo-redis-1 Healthy
 Container demo-firebase-auth-1 Healthy
 Container demo-casino-sim-1 Healthy
 Container demo-payments-1 Healthy
 Container demo-identity-1 Healthy
 Container demo-postgres-1 Healthy
 Container demo-engagement-1 Healthy
 Container demo-web-1 Healthy
real    1m1.7s
```

```text
$ docker compose ps
SERVICE         STATUS                    PORTS
casino-sim      Up 56 seconds (healthy)   0.0.0.0:4004->4004/tcp
engagement      Up 48 seconds (healthy)   0.0.0.0:4002->4002/tcp
firebase-auth   Up 57 seconds (healthy)   0.0.0.0:9099->9099/tcp
identity        Up 18 seconds (healthy)   0.0.0.0:4001->4001/tcp
payments        Up 48 seconds (healthy)   0.0.0.0:4003->4003/tcp
postgres        Up 58 seconds (healthy)   0.0.0.0:54329->5432/tcp
rabbitmq        Up 57 seconds (healthy)   5672/tcp, 15672/tcp (management)
redis           Up 59 seconds (healthy)   0.0.0.0:56379->6379/tcp
web             Up 6 seconds (healthy)    0.0.0.0:3000->3000/tcp
```

Check that every service answers (liveness, then readiness, which also checks its dependencies):

```sh
for p in 4001 4002 4003 4004; do curl -s localhost:$p/healthz/ready; echo; done
```

```json
{"status":"ok","uptime":13.67,"version":"0.0.1","checks":{"db":{"status":"ok","latencyMs":1},"amqp":{"status":"ok","latencyMs":0}}}
{"status":"ok","uptime":42.15,"version":"0.0.1","checks":{"db":{"status":"ok","latencyMs":1},"amqp":{"status":"ok","latencyMs":0},"redis":{"status":"ok","latencyMs":1}}}
{"status":"ok","uptime":42.46,"version":"0.0.1","checks":{"db":{"status":"ok","latencyMs":1},"amqp":{"status":"ok","latencyMs":0}}}
{"status":"ok","uptime":56.09,"version":"0.1.0","checks":{}}
```

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
cases) is one request per file in [`docs/samples/`](docs/samples/), in the `.http` format, with responses
captured from a real run. The whole story, including every Part C case, runs as one script that needs only
`bash`, `curl`, `jq` and `openssl`:

```sh
docker compose up -d --wait
scripts/demo.sh            # prints each request and the trimmed response, asserts it, exits non-zero on a mismatch
```

Its Part C steps are C-1 duplicate deposit, C-2 concurrent spins, C-3 duplicate redemption, C-4 casino timeout,
C-5 invalid or unauthorized events, C-6 player isolation (C-6b no negative balance), C-7 tenant isolation and
C-8 failed reward issuance (casino B rejects the bonus: the coins stay held while the ticket is pending, then the
order ends `RELEASED`, the balance returns to the baseline exactly once and the stock and per-player limit come
back). C-8 was added after the recorded run below, so that run has no output for it.

Recorded output of that script on a clean stack (secrets and tokens shown as `<redacted>`, bodies trimmed).
The first run of 37 steps made 133 assertions pass and recorded 13 failures, all from two product gaps listed
under "Known gaps from the recorded run" below.

Workflow steps 1-3, a signed deposit from casino A (schema A, HMAC over `timestamp.body`) and from casino B
(schema B, signature inside the body). The casino simulator builds and signs the webhook:

```text
> POST 4004/casino-a/__deposit  body={"target_url":"http://engagement:4002/v1/integrations/demo-a-16018/events","secret":"<redacted>","player_id":"A-PLAYER-77","amount_minor":5000,"currency":"EUR","event_id":"evt-a-16018-1"}
< 200 {"delivered":[200]}
> POST 4004/casino-b/__deposit  body={"target_url":"http://engagement:4002/v1/integrations/demo-b-16018/events","secret":"<redacted>","player_id":"B-PLAYER-12","amount_minor":5000,"currency":"EUR","event_id":"evt-b-16018-1"}
< 200 {"delivered":[200]}
> GET 4002/v1/me/spins [authorization: Bearer <redacted>]        (player A, after the rules engine ran over the bus)
< 200 {"available":1}
```

Workflow steps 4-5, the spin and the balance. The same Idempotency-Key replays the same spin:

```text
> GET 4002/v1/wheel
< 200 {"wheel_id":"0190a1b2-c3d4-4e5f-8a6b-2000000000a1","segments":[{"label":"200 coins"},{"label":"300 coins"},{"label":"500 coins"}]}
> POST 4002/v1/spins [idempotency-key: spin-a-16018-1] body={}
< 201 {"spin_id":"01a2012d-49ac-7223-b6b6-7b6c69073dd5","segment_index":0,"segment_label":"200 coins","reward_coins":200}
> POST 4002/v1/spins [idempotency-key: spin-a-16018-1] body={}
< 201 {"spin_id":"01a2012d-49ac-7223-b6b6-7b6c69073dd5","segment_index":0,"segment_label":"200 coins","reward_coins":200}
> GET 4003/v1/me/balance
< 200 {"wallet_id":"01a2012d-4b5f-7089-bb44-30ea714130c2","available":200,"held":0,"currency":"COIN"}
```

Workflow steps 6-8, the redemption and its final status. This is where the recorded run stops short of the
goal: the order reserves the coins and then lands in `NEEDS_REVIEW` with `failure_reason: no_adapter` and the
casino simulator receives nothing, so the status never becomes `ISSUED` or `COMPLETED` (see the known gaps):

```text
> POST 4002/v1/redemptions [idempotency-key: redeem-b-16018-1] body={"item_id":"01a2012c-ed93-7bf6-aec8-941f3f7d1de4"}
< 202 {"id":"01a2012e-5537-7aa0-90e5-4f20e0475a3e","price":50,"status":"pending","state":"RESERVED","attempts":0,"casino_reference":null,...}
> GET 4002/v1/operator/redemptions/01a2012e-5537-7aa0-90e5-4f20e0475a3e
< 200 {"status":"pending","state":"NEEDS_REVIEW","failure_reason":"no_adapter","history":[{"from":null,"to":"REQUESTED","cause":"order_placed"},{"from":"REQUESTED","to":"RESERVED","cause":"reserved"},...]}
> GET 4004/__issued?casino=b
< 200 []
```

Part C cases from the same run:

```text
# duplicate deposit: the casino delivers one webhook three times, the player gets one spin
> POST 4004/__faults body={"casino":"a","kind":"duplicateDelivery","times":1,"copies":3}
> POST 4004/casino-a/__deposit body={...,"event_id":"evt-a-16018-dup"}
< 200 {"delivered":[200,200,200]}
> GET 4002/v1/me/spins
< 200 {"available":1}

# concurrent spins: 10 parallel requests with distinct keys against one credit
< 1 x 201; 9 x 409          then GET /v1/me/spins -> {"available":0}

# duplicate redemption: the same Idempotency-Key 5 times in parallel
< 1 x 202; 4 x 409      one redemption id, coins debited once (available 450 -> 400)
> POST 4002/v1/redemptions (same key again)
< 202 + header Idempotent-Replayed: true, same id

# unsigned, wrongly signed, and other-tenant-signed events
> POST 4002/v1/integrations/demo-a-16018/events                       (no signature)
< 401 {"message":"signature check failed","code":"signature_missing"}
> POST ... x-a-signature: 0000...0000
< 401 {"message":"signature check failed","code":"signature_invalid"}
> POST ... x-a-signature: <valid HMAC with casino B's secret>
< 401 {"message":"signature check failed","code":"signature_invalid"}
> POST 4002/v1/spins   (no token)
< 401 {"code":"TENANT_REQUIRED","message":"authentication required"}

# a player with no coins redeems: no negative balance
< 409 {"message":"not enough coins","code":"insufficient_funds"}

# tenant isolation: casino B reads casino A's redemption
> GET 4002/v1/operator/redemptions/<casino A redemption id>   (casino B operator token)
< 404 {"message":"redemption not found","code":"redemption_not_found"}
> GET 4002/v1/redemptions/<casino A redemption id>            (casino B player token)
< 404 {"message":"redemption not found","code":"redemption_not_found"}
```

Realtime through the web origin (one Socket.IO client, namespace `/rt`, one-time ticket from
`POST /v1/auth/realtime-ticket`). The pushed frames arrived on the direct engagement origin:

```text
< 42/rt,["notification",{"type":"spin.result","payload":{"spin_id":"01a20116-df48-...","reward_coins":200,"table_version":1},...}]
< 42/rt,["notification",{"type":"balance.changed","payload":{"reason":"credited","amount":200},...}]
```

### Known gaps from the recorded run

The first recorded run exposed three gaps. All three are closed (decision D-27); the captured output above is
from that first run.

- **Socket.IO.** The web `/config` now returns `realtimeUrl` (engagement's public URL, `PUBLIC_REALTIME_URL`),
  engagement allows the web origin (`REALTIME_ALLOWED_ORIGINS`), and the same-origin `/socket.io` rewrite
  stays as a fallback with `skipTrailingSlashRedirect` so `/socket.io/` is no longer redirected.
- **Redemption reaching the casino.** An operator registers the casino reward API with
  `PUT /v1/operator/integrations/:casino/reward-api` (identity); it is served to engagement as `reward_api`.
  The URL is checked twice (D-30). The PUT refuses credentials in the URL and literal loopback, private,
  link-local (cloud metadata) and unspecified addresses. Engagement's transport resolves the host at call
  time and refuses the same ranges, never follows a redirect (a 3xx counts as "outcome unknown"), and in
  production requires `https`; identity's PUT likewise refuses a plain-http URL for the `production`
  environment (the sandbox endpoint may be http). `REWARD_API_ALLOW_HOSTS` (comma separated host names,
  read by identity and engagement) exempts listed hosts from the https rule, and from the address rule in
  engagement's transport; compose sets it to `casino-sim` on both services. The casino's rejection
  reason is cut to 64 characters of `[A-Za-z0-9_.:-]` before it is stored or shown.
- **The environment is always stated (INV-ENV-INPUT, D-29).** Nothing defaults to production. These requests
  now answer **400 `VALIDATION_FAILED`** when `environment` (`production` or `sandbox`) is missing:
  `POST /v1/credentials` (body `{ platform, environment }`), `PUT /v1/operator/integrations/:casino/reward-api`
  (body `{ environment, base_url, ... }`), and the internal `GET /internal/v1/tenants/:tenantId/players/:playerId/balance`
  (query `sandbox=true|false`, service tokens only). A player's environment is never a request field: it comes
  from the launch token, and the realtime ticket carries it (a sandbox player gets a sandbox ticket). An event
  without `sandbox` is invalid and goes to the dead-letter path.
- **Wheel, rules and subscription id.** `PUT /v1/operator/wheel` and `PUT /v1/operator/rules` (engagement,
  `operator_admin`), a default wheel and rule on signup, and `GET /v1/operator/plan` (payments) replace the
  database steps; the script no longer reads or writes any database.

## Service map, ports and environment

| Container       | Host port          | Owns                                                                                                                         |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `web`           | 3000               | Next.js app: player widget and operator console, a BFF in front of the services                                              |
| `identity`      | 4001               | tenants, users, tokens and JWKS, player mapping, integration credentials, audit (own database)                               |
| `engagement`    | 4002               | casino ingest and adapters, rules, wheel and spins, Bonus Store, redemption saga, the `/rt` Socket.IO gateway (own database) |
| `payments`      | 4003               | the only place coins change: ledger, reserves, reconciliation, plan billing (own database)                                   |
| `casino-sim`    | 4004               | two simulated casinos with fault injection (`SIM_FAULTS=1` in compose)                                                       |
| `postgres`      | 54329              | one database and one non-superuser app role per service, plus an owner role for migrations                                   |
| `rabbitmq`      | 55672, UI on 15672 | event bus (outbox and inbox in every service)                                                                                |
| `redis`         | 56379              | append-only persistence; an optional balance projection and a health probe                                                   |
| `firebase-auth` | 9099               | Firebase Auth Emulator, project `demo-ex-mio`                                                                                |

How the services talk: services publish events over RabbitMQ through a transactional outbox and consume them
through an idempotent inbox. Two calls are synchronous: the coin reserve for a redemption (engagement to
payments) and service-token and credential lookups (to identity). Every service trusts only tokens identity
signed (RS256, keys at `/.well-known/jwks.json`). The tenant comes from the verified `tid` claim; no header names
a tenant. Payments has no credit route: coins arrive only from `engagement.spin.completed` events.

Infrastructure ports are not the defaults, so a database already running on your machine does not collide.
Override any host port with the variable named in `docker-compose.yml` (`POSTGRES_PORT`, `RABBITMQ_PORT`,
`REDIS_PORT`, `WEB_PORT`, `IDENTITY_PORT`, `CASINO_SIM_PORT`, ...).

Main variables (all have a working default in compose; the values there are for local development only):

| Variable                                          | Service              | Meaning                                                                                                          |
| ------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                    | every service        | runtime connection as `<service>_app` (not the owner, no DDL)                                                    |
| `MIGRATION_DATABASE_URL`                          | every service        | connection as `<service>_owner`, used by `node dist/migrate.js` only                                             |
| `IDENTITY_URL`                                    | engagement, payments | where tokens and keys are verified                                                                               |
| `SERVICE_CLIENT_SECRET`                           | engagement, payments | this service's client secret for service tokens                                                                  |
| `SERVICE_CLIENT_SECRETS`                          | identity             | the registry of service client secrets                                                                           |
| `CREDENTIALS_KEK`                                 | identity             | key that encrypts casino integration secrets                                                                     |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | identity             | the platform admin                                                                                               |
| `IDENTITY_PROVIDER`                               | identity             | `firebase-emulator` (default) or `fake` (tests only)                                                             |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FIREBASE_PROJECT` | identity             | the emulator address and project                                                                                 |
| `BASE_DOMAIN`                                     | identity             | tenants resolve from `<slug>.<BASE_DOMAIN>` (`mio.localhost`)                                                    |
| `REDIS_URL`                                       | engagement, payments | optional; payments uses it for the balance projection                                                            |
| `PAYMENTS_URL`                                    | engagement           | where the coin reserve is called                                                                                 |
| `FAKE_PROVIDER_WEBHOOK_SECRET`                    | payments             | billing webhook secret; required in production unless Stripe is set                                              |
| `STRIPE_SECRET_KEY`                               | payments             | selects the Stripe stub, which throws on every call                                                              |
| `LEDGER_JOBS_INTERVAL_SECONDS`                    | payments             | interval of the reconciliation and usage-report jobs                                                             |
| `DATABASE_SSL`                                    | every service        | `disable`, `require` or `verify-full`; stated explicitly in production                                           |
| `API_URL`                                         | web                  | server-side URL of identity inside the compose network                                                           |
| `IDENTITY_URL`, `ENGAGEMENT_URL`, `PAYMENTS_URL`  | web (BFF)            | where the BFF calls the services (compose: `identity:4001`, `engagement:4002`, `payments:4003`)                  |
| `MIO_API`                                         | web (build time)     | compose build arg for `NEXT_PUBLIC_MIO_API`: `http` (default, live) or `mock`                                    |
| `BASE_DOMAIN`, `FAKE_PROVIDER_WEBHOOK_SECRET`     | web (BFF)            | tenant host suffix for the console login; the dev secret the BFF signs the provider callback with (compose only) |
| `REALTIME_UPSTREAM`                               | web (build time)     | where `/socket.io/*` is proxied (default `http://engagement:4002`)                                               |
| `REALTIME_ALLOWED_ORIGINS`                        | engagement           | comma-separated origins that may open a socket cross-origin                                                      |
| `SIM_FAULTS`                                      | casino-sim           | `1` turns on fault injection                                                                                     |

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

| Suite                                                                               | Command                                                                                                                                     | Needs                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| All unit and contract tests                                                         | `pnpm test` (nx, every project)                                                                                                             | nothing running                                                |
| One service or package                                                              | `pnpm --filter @ex-mio/<name> test` (identity, engagement, payments, contracts, service-kit, bus, tenancy, idempotency, logger, casino-sim) | nothing running                                                |
| Web                                                                                 | `pnpm --filter @ex-mio/web test` (vitest)                                                                                                   | nothing running                                                |
| Design system, contrast and colour gate                                             | `pnpm --filter @ex-mio/ui test`                                                                                                             | nothing running                                                |
| Payments against Postgres                                                           | `pnpm --filter @ex-mio/payments test:db`                                                                                                    | `docker compose up -d --wait postgres`                         |
| Engagement store against Postgres                                                   | `pnpm --filter @ex-mio/engagement test:pg`                                                                                                  | `docker compose up -d --wait postgres`                         |
| Whole stack: health, roles, tenant isolation, idempotency, bus, ingest, saga, audit | `pnpm test:compose`                                                                                                                         | `docker compose up -d --wait` (the stack on its default ports) |
| Lint (layering, package boundaries)                                                 | `pnpm lint`                                                                                                                                 | nothing running                                                |
| Typecheck                                                                           | `pnpm typecheck`                                                                                                                            | nothing running                                                |
| Frontend layering                                                                   | `pnpm lint:fsd`                                                                                                                             | nothing running                                                |
| Design system in a browser                                                          | `pnpm storybook` (port 6006)                                                                                                                | nothing running                                                |

`pnpm test` (`nx run-many -t test`, one project at a time) on this commit. Twelve of the thirteen projects pass:

```text
@ex-mio/contracts     102 passed        @ex-mio/engagement    323 passed
@ex-mio/tenancy        19 passed        @ex-mio/payments      174 passed
@ex-mio/logger         49 passed        @ex-mio/identity      244 passed
@ex-mio/bus            16 passed        @ex-mio/casino-sim     25 passed
@ex-mio/idempotency     6 passed        @ex-mio/ui             89 passed
@ex-mio/service-kit   127 passed        @ex-mio/web           163 passed, 1 failed (164)
```

The one failure is a web timing test that ran on a machine at load average 30:
`player-widget-money.test.tsx` "says the result is unknown, re-queries, and shows the result when the re-query
succeeds" did not find the text `Result unknown` within its wait. It was not re-run in isolation, so it is not
yet shown to be a flake.

<!-- OUTPUT: `pnpm --filter @ex-mio/payments test:db` and `pnpm --filter @ex-mio/engagement test:pg` -->
<!-- OUTPUT: `pnpm test:compose` (suite and test counts against the running stack) -->

```text
$ pnpm lint
 NX   Successfully ran target lint for 13 projects
$ pnpm typecheck
 NX   Successfully ran target typecheck for 13 projects and 6 tasks they depend on
```

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
- Rules, reward tables and store items are tenant configuration, and odds changes are versioned. A new
  rule or wheel version is published with `PUT /v1/operator/rules` and `PUT /v1/operator/wheel`, and the live
  console calls them. No route returns the published version in the console's shape, so the console keeps its own copy.
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

| Area                                                                                         | Status                                                                                                         |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Five services, one container and one database each, one compose file                         | Built                                                                                                          |
| Tenancy: token claim, row-level security, separate owner and app roles, isolation tests      | Built                                                                                                          |
| Two casino adapters, canonical model, adapter contract suite, simulator with fault injection | Built                                                                                                          |
| Signed event ingestion, validation, deduplication, outbox and inbox, dead-letter replay      | Built                                                                                                          |
| Rules engine, versioned reward table, server-side deterministic wheel                        | Built                                                                                                          |
| Double-entry coin ledger, reserve, capture, release, refund, reconciliation job              | Built (reports a mismatch, no pager)                                                                           |
| Bonus Store, redemption saga with recovery from unknown outcomes, operator review route      | Built                                                                                                          |
| Identity: tokens, JWKS, RBAC, acting sessions with audit, service tokens, launch exchange    | Built                                                                                                          |
| Operator signup and plan checkout against the fake provider                                  | Built                                                                                                          |
| Realtime push over Socket.IO with a one-time ticket                                          | Built, at most once                                                                                            |
| Web: player widget and operator console                                                      | Built; live against the services by default. Sandbox check, go-live and coin history are mock (see known gaps) |
| Product events for Varta                                                                     | Partial: contract and logger function, no service emits yet                                                    |
| Redis balance projection                                                                     | Partial: wired, optional, off in default compose                                                               |
| Missed-event replay on websocket reconnect                                                   | Next                                                                                                           |
| Rate limiting                                                                                | Next                                                                                                           |
| Stripe payment provider                                                                      | Next (interface and a stub that throws)                                                                        |
| Production identity provider, refresh tokens                                                 | Next                                                                                                           |
| Provably-fair seed commitment, RNG certification                                             | Next                                                                                                           |
| Per-service deployment secrets                                                               | Next, not claimed                                                                                              |
| Deckhand deploy and Varta wiring                                                             | Described, not run here                                                                                        |

## Where the answers are

| Part                                      | Answer                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A: architecture                           | [`docs/architecture/`](docs/architecture/README.md) (diagrams), [`overview.md`](docs/architecture/overview.md), [`docs/adrs/`](docs/adrs/) |
| B: working prototype                      | this README, the flows in [`docs/samples/`](docs/samples/), the service specs in [`docs/specs/`](docs/specs/)                              |
| C: reliability and security               | [`docs/submission/part-c.md`](docs/submission/part-c.md) and the reliability matrix in the overview                                        |
| D: AI-native development                  | [`docs/ai/`](docs/ai/README.md): process, decisions, defects found, verification                                                           |
| E: scaling, first 90 days, team           | [`docs/scaling/`](docs/scaling/README.md) and [`90-days.md`](docs/scaling/90-days.md)                                                      |
| What is missing                           | [`docs/submission/known-gaps.md`](docs/submission/known-gaps.md)                                                                           |
| The backlog (17 epics, tasks, acceptance) | [`backlog/`](backlog/README.md)                                                                                                            |

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
  `fake` identity provider. Migrations are a separate step: the manifest `.deckhand/deploy.yml` runs
  `docker run <service image> node dist/migrate.js` inline for each service (the Deckhand container has no checkout,
  so it cannot run a repo script); `scripts/migrate-all.sh` is the same loop for a shell.

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
6. Service routes for the sandbox check, go-live and reading the published rules and wheel back, so the console stops answering them from its mock.
7. Per-service deployment secrets and the blue-green rollout through Deckhand; observability through Varta.
8. Move integrations into their own service when a second operator team needs independent releases.

## How this was built

Planned and built with AI coding agents under a review framework (review-framework) that requires a regression
test at the choke point and a re-applied mutation for every claimed fix. The service skeleton comes from the
monorepo starter. Evidence, and the decisions made by hand, are in [`docs/ai/`](docs/ai/README.md).

## License

MIT, see [`LICENSE`](LICENSE).
