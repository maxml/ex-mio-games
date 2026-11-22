# MIO Games (ex-mio-games)

MIO Games is a platform that online casinos would plug into to give their players a game layer: a Wheel of
Fortune earned by depositing, virtual coins, and a Bonus Store where coins buy rewards that the casino issues.
This repository is a working vertical slice of it, built for the MIO Games test task. Everything outside MIO is
simulated: the two casinos are a bundled simulator (casino-sim), sign-in runs on the Firebase Auth Emulator and
payments use a fake provider. No real casino or payment service is connected, and Varta and Deckhand are optional
and off in the local run. [CI](https://github.com/maxml/ex-mio-games/actions/workflows/ci.yml)
runs format, lint, typecheck and unit tests on every push, then starts the compose stack and runs the compose
suites, the database suites and the demo against it.
Terms used here are explained in the [glossary](docs/glossary.md).

## What was done

- A running prototype: 5 services (identity, engagement, payments, web, casino-sim) in 9 containers, 2 simulated
  casinos with different APIs, each with its own adapter in MIO, an operator console and a player widget that call
  MIO's own services.
- Proof: a demo of 40 steps and 194 assertions, and 250 compose tests, with the output in [`evidence/`](evidence/README.md).
- Design: 14 ADRs and 5 architecture diagrams in [`docs/adrs/`](docs/adrs/) and [`docs/architecture/`](docs/architecture/README.md).
- Process: AI agents in separate roles, with reviews of up to three rounds per area. See [How AI was used](#how-ai-was-used).
- Planning: the whole product is split into a backlog of **168 tasks in 18 epics**, each with acceptance criteria
  and a risk class. The prototype implements the first slice (P0, 49 tasks) and the Part C reliability cases; the
  rest of the tasks are planned, not built. Start at [`backlog/README.md`](backlog/README.md). The effort estimate for a
  human team to take it to production is in [`docs/scaling/`](docs/scaling/README.md).

Why these tasks, in this order: the first goal is a sellable slice (priority P0): an operator signs up, registers a
casino, and a deposit turns into a spin, coins and an issued reward. Here the casino is the simulator. Anything that protects money or tenant data
comes before features. Each task carries a risk class (guard, identity, admission, budget, locks, concurrency,
ownership, isolation), and a task with a class goes through a spec and failing tests before code. This
prototype implements the slice and the reliability cases of Part C. Real billing (only a fake provider exists), rate limits,
the production deploy and the later products (PvP, Missions, Kingdom Builder) are planned in the backlog and not built.

## How we prioritised

The assignment had a limit of 8 hours. This repository chose a product start instead: a small working
slice that an operator could try against simulated casinos, with the planning for the rest written down. The order was:

1. The money path: deposit, spin, coins, store, issued reward, and the plan payment.
2. The protections around it: signatures, deduplication, one winner for concurrent spins, idempotent
   redemption, no negative balance, tenant isolation.
3. The evidence: the demo, the compose suites, the captured outputs and the CI run.

Deferred, with reasons: rate limits, load tests, the production deploy, Stripe and the later products. Each deferred
item is a task in [`backlog/`](backlog/README.md), and the follow-ups from the review rounds are listed in
[`docs/submission/known-gaps.md`](docs/submission/known-gaps.md). The decision to build inside the product with a
two-day deadline is recorded in [`docs/ai/decisions.md`](docs/ai/decisions.md).

The principles behind the design, each linked to where the repo does it:

- Money first: the backlog priorities follow profit impact, and P0 is the first sellable slice ([backlog](backlog/README.md)).
- Think hard only about decisions that are expensive to reverse: tenancy ([ADR 0002](docs/adrs/0002-tenancy-model.md)),
  the coin ledger ([ADR 0004](docs/adrs/0004-virtual-currency-ledger.md)), identity
  ([ADR 0007](docs/adrs/0007-identity-interface-and-emulator.md)) and the analytics event taxonomy
  ([ADR 0009](docs/adrs/0009-analytics-via-varta.md)). The rest stays simple: controllers validate input and
  services hold the logic.
- Services where a boundary protects something: payments is separate, and coins move only through it
  ([ADR 0001](docs/adrs/0001-microservices-and-their-cost.md)). Tenants and integrations are modules behind Nx
  boundaries ([ADR 0008](docs/adrs/0008-integration-adapters-canonical-model.md)).
- A message broker from the start, with outbox and inbox ([ADR 0003](docs/adrs/0003-rabbitmq-outbox-inbox.md)).
- Identity and the payment provider sit behind interfaces. Sign-in runs on the Firebase Auth Emulator and payments on
  a fake provider, so no accounts are needed. Stripe is a stub behind the same interface, and the fake provider is what runs.
- A websocket client that reconnects and resyncs over REST ([ADR 0014](docs/adrs/0014-realtime-websocket-client.md)).
- Product analytics from day one through Varta, and a design system built in Storybook
  ([`packages/ui`](packages/ui/TOKENS.md), [ADR 0013](docs/adrs/0013-fsd-frontend-architecture.md)).
- Ready for AI work: agent prompts live in the repo and every change goes through a role-separated, reviewed
  process ([`prompts/`](prompts/README.md), [`docs/ai/`](docs/ai/README.md)).
- Built on a monorepo starter with Nx boundaries, and diagrams kept as code with archify
  ([ADR 0012](docs/adrs/0012-archify-and-mermaid.md)).

## Where things are

The seven deliverables of the task, in the order the task lists them:

1. Working code: `apps/` (identity, engagement, payments, web, casino-sim), `packages/` (contracts, tenancy, bus,
   idempotency, logger, service-kit, ui), `tests/compose/`, `docker-compose.yml`. The service map is [below](#service-map-ports-and-environment).
2. README with setup and assumptions: [Run it from a clean clone](#run-it-from-a-clean-clone), [Assumptions](#assumptions),
   and `scripts/setup.sh`, which checks the tools the demo needs.
3. Architecture diagrams: [`docs/architecture/`](docs/architecture/README.md) and the
   [overview](docs/architecture/overview.md); the decisions are in [`docs/adrs/`](docs/adrs/).
4. Automated tests: [Tests](#tests) for the commands, [`evidence/`](evidence/README.md) for the captured runs and
   [CI](https://github.com/maxml/ex-mio-games/actions/workflows/ci.yml) for the green build.
5. Sample requests and responses: [`docs/samples/`](docs/samples/README.md).
6. AI evidence log: [`docs/ai/`](docs/ai/README.md) and the agent instructions in [`prompts/`](prompts/).
7. First 90-day plan: [`docs/scaling/90-days.md`](docs/scaling/90-days.md).

By part of the task:

- Part A, architecture: [`docs/architecture/overview.md`](docs/architecture/overview.md) and [`docs/adrs/`](docs/adrs/).
- Part B, working prototype: this README, the 8-step flow in [Try the 8-step workflow](#try-the-8-step-workflow) and `scripts/demo.sh`.
- Part C, reliability and security: [`docs/submission/part-c.md`](docs/submission/part-c.md).
- Part D, AI-native development: [`docs/ai/`](docs/ai/README.md).
- Part E, scaling the product: [`docs/scaling/`](docs/scaling/README.md).

## Architecture: how to view it

Three ways, from quickest to richest:

1. The system diagram below is Mermaid, which GitHub draws in place.
2. PNG renders of all five diagrams are in [`docs/architecture/img/`](docs/architecture/img/). The overview:
   ![MIO Games: context and containers](docs/architecture/img/architecture.png)
3. The interactive pages are standalone HTML files. Open one locally, for example
   `xdg-open docs/architecture/architecture.html` on Linux or `open docs/architecture/architecture.html` on macOS.
   GitHub shows their source, not the page.

```mermaid
flowchart LR
  player([Player browser]) -->|HTTPS| web
  casino([casino-sim: Casino A and B]) -->|signed events, HMAC| engagement
  engagement -.->|issue reward, status| casino

  subgraph platform [MIO Games platform: one container per service]
    web[web: widget and operator console]
    identity[identity: authN, authZ, tenants module]
    engagement[engagement: ingestion, integrations module, rules, wheel, store, saga]
    payments[payments: ledger, coin operations, fake provider]
    rabbit{{RabbitMQ: outbox and inbox}}
    redis[(Redis: optional balance projection)]
    idb[(Postgres identity)]
    edb[(Postgres engagement)]
    pdb[(Postgres payments)]
  end

  web -->|login, launch| identity
  web -->|REST, websocket /rt| engagement
  web -->|BFF| payments
  engagement -->|reserve, capture, release, refund| payments
  engagement -->|service token, secrets, player resolve, ticket redeem| identity
  payments -->|tenant status| identity
  identity --> idb
  engagement --> edb
  payments --> pdb
  identity -.-> rabbit
  engagement -.-> rabbit
  payments -.-> rabbit
  rabbit -.-> identity
  rabbit -.-> engagement
  rabbit -.-> payments
  engagement -.->|health probe; payments projection optional, off in compose| redis

  varta[[Varta: observability and analytics]]
  deckhand[[Deckhand: blue-green deploy]]
  platform -.->|logs, events on stdout| varta
  deckhand -.->|deploys containers| platform
```

| Diagram                                                                                      | Question it answers                                             | ADRs                                     | Part A items                                                                                |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Context and containers](docs/architecture/README.md#1-context-and-containers)               | What are the parts and who talks to whom?                       | 0001, 0002, 0003, 0007, 0008, 0009, 0011 | tenant isolation, integration layer, identity mapping, ledger, admin console, observability |
| [Sequence](docs/architecture/README.md#2-sequence-the-8-step-workflow)                       | What happens from deposit to a tracked reward?                  | 0003, 0004, 0005, 0006, 0008             | ingestion and deduplication, identity mapping, ledger, redemption                           |
| [Redemption saga](docs/architecture/README.md#3-workflow-redemption-saga-with-compensations) | Which steps and compensations does a redemption run?            | 0004, 0006, 0008                         | redemption and delivery                                                                     |
| [ERD](docs/architecture/README.md#4-erd-tenancy-and-ledger)                                  | Which tables carry the tenant, and how does the ledger balance? | 0002, 0004, 0007                         | tenant isolation, ledger, identity mapping                                                  |
| [Lifecycle](docs/architecture/README.md#5-lifecycle-redemption-states)                       | Which redemption states and moves are allowed?                  | 0006                                     | redemption and delivery                                                                     |

The rules engine, admin configuration, and observability and security have no diagram of their own. The hub
[`docs/architecture/README.md`](docs/architecture/README.md) says why each diagram exists and links the specs and
reliability cases.

## What was built

One complete flow runs end to end against two simulated casinos that have different event formats, signature
schemes and reward APIs:

1. A casino sends a signed deposit event. MIO checks the signature, validates it and drops duplicates.
2. The player gets one spin. The server picks the result from the operator's weighted reward table and the
   coins go into a double-entry ledger.
3. The player spends coins in the Bonus Store. MIO asks the casino, through that casino's adapter, to issue the
   reward, and tracks the order until the casino reports a final status.
4. The operator configures rules, wheel, store and casino credentials in a console. The player sees the wheel
   and the store in a widget. Both call MIO's own services instead of mock data.

Both casinos go through the same rules, wheel, ledger and store code. Only the adapter differs.

## What it guarantees

- No double rewards. A repeated deposit, a repeated redemption and parallel spins each produce one result.
- No negative coin balance, including when two redemptions race for the same coins.
- Tenant isolation. Each casino sees only its own data, enforced in the database with row-level security as
  well as in the services, on every tenant data table (the bus tables `outbox`/`inbox` and three platform tables are cross-tenant by design, and the sweeper and audit tables have a narrow platform-read branch). The exact list, and the known gap for the bus tables, is in [`docs/architecture/overview.md`](docs/architecture/overview.md) (section 3) and S-27 in the known gaps.
- Sandbox and production are separate environments. Spin credits, event deduplication and tokens are kept per
  environment, so a sandbox token cannot use a production credit. Production here is a separate environment inside the local
  stack; no production deployment exists.
- The wheel is decided on the server and is deterministic for a given seed. The client cannot send weights or
  a result, and the public wheel view hides the weights.

## How it was proven

`scripts/demo.sh` runs the whole flow and every reliability case against the running stack. Its last recorded
run printed `DONE: 40 steps, 194 assertions passed, 0 recorded failure(s)`. The compose suites run against real
Postgres and RabbitMQ: 250 of 250 passed, and the payments and engagement database suites passed 181 of 181 and
50 of 50. The captured outputs are in [`evidence/`](evidence/README.md), and CI is green on `main`.

## Architecture in short

Three domain services (identity, engagement, payments), each with its own database, run next to a web app, a
casino simulator, RabbitMQ, Postgres and Redis in one Docker Compose file. Payments is the only writer of coins, identity signs tokens, and engagement
holds the rules, wheel, store and the casino adapters. Services exchange events through RabbitMQ with an outbox and an inbox, and each
domain service has its own database. See [`docs/architecture/overview.md`](docs/architecture/overview.md) for the
diagrams and the reasons, and [`docs/how-to/where-to-change.md`](docs/how-to/where-to-change.md) for where to add
a third casino or a reward type.

The 14 architecture decision records in [`docs/adrs/`](docs/adrs/), each as options considered, the one chosen, and why:

| ADR                                                            | Options considered                                                                                      | Chosen                                                     | Why                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [0001](docs/adrs/0001-microservices-and-their-cost.md)         | Modular monolith; three domain services; one service per module                                         | Three services (identity, engagement, payments)            | Money gets one writer and the trust boundary stays apart, without the cost of a service per module.                                 |
| [0002](docs/adrs/0002-tenancy-model.md)                        | Database per tenant; shared database with RLS; app-level filtering only                                 | Shared database per service with row-level security        | Isolation is enforced and testable in the database, and the tenant never comes from a client field.                                 |
| [0003](docs/adrs/0003-rabbitmq-outbox-inbox.md)                | Kafka; RabbitMQ; direct HTTP                                                                            | RabbitMQ with outbox and inbox                             | Delivery is at least once, so the inbox and outbox make effects exactly once with a small local footprint.                          |
| [0004](docs/adrs/0004-virtual-currency-ledger.md)              | Balance column; append-only entries; double-entry journal                                               | Double-entry journal with a cached balance                 | A reviewer can prove that entries sum to the balance, and retries repeat nothing.                                                   |
| [0005](docs/adrs/0005-rng-and-fairness.md)                     | `Math.random()`; keyed hash of a server seed; commit-reveal                                             | Keyed hash of a secret seed and the spin id                | The result is reproducible from stored data and the client has no influence.                                                        |
| [0006](docs/adrs/0006-redemption-saga.md)                      | Two-phase commit; orchestrated saga; choreographed saga                                                 | Orchestrated saga with compensations                       | A timeout is not a failure, and every step is retryable under its own key.                                                          |
| [0007](docs/adrs/0007-identity-interface-and-emulator.md)      | One provider's SDK; an interface with an emulator; own credential store                                 | Interface with the Firebase Auth Emulator                  | A clean clone needs no accounts, and the provider can change later.                                                                 |
| [0008](docs/adrs/0008-integration-adapters-canonical-model.md) | Branch on platform in the logic; per-casino adapter; configuration-only mapping                         | Per-casino adapter and a canonical model                   | Rules, wheel and ledger know no casino format, and a new casino is one adapter.                                                     |
| [0009](docs/adrs/0009-analytics-via-varta.md)                  | A separate analytics tool; JSON lines on stdout; push from code                                         | JSON lines on stdout, collected by Varta                   | No runtime dependency on Varta, one panel, and no personal data in events.                                                          |
| [0010](docs/adrs/0010-typeorm.md)                              | TypeORM; Prisma; query builder                                                                          | TypeORM                                                    | NestJS fits it, and raw SQL stays easy for RLS, triggers and conditional updates.                                                   |
| [0011](docs/adrs/0011-container-per-service-and-deckhand.md)   | One image with several entry points; one container per deployable; Kubernetes                           | One container per deployable, deployed through Deckhand    | One command starts the stack, and the deploy tool is not reinvented.                                                                |
| [0012](docs/adrs/0012-archify-and-mermaid.md)                  | Mermaid only; archify only; archify with a Mermaid copy                                                 | Archify source plus a Mermaid copy                         | Interactive pages for exploring and readable diagrams on any git host.                                                              |
| [0013](docs/adrs/0013-fsd-frontend-architecture.md)            | Flat Next app; Atomic Design only; Bulletproof React; Feature-Sliced Design; Clean Architecture or MVVM | Feature-Sliced Design with enforced boundaries             | ESLint fails the CI build when an import crosses a layer; Steiger runs only in the Deckhand pipeline and by hand (`pnpm lint:fsd`). |
| [0014](docs/adrs/0014-realtime-websocket-client.md)            | Polling; server-sent events; one socket.io client per tab                                               | Shared socket.io client with backoff and a one-time ticket | Results arrive without a reload and outages heal; missed events are refetched over REST.                                            |

## What you can try in 5 minutes

```sh
git clone https://github.com/maxml/ex-mio-games && cd ex-mio-games
scripts/setup.sh                              # checks docker, compose v2, bash 4+, curl, jq, openssl; offers to install gaps
docker compose up -d --wait && scripts/demo.sh
```

The first build takes a few minutes. Then open `http://localhost:3000/en/operator` for the operator console. No
account is needed. `scripts/setup.sh --check` only reports, and `--yes` answers every install question
with yes. Details are in [Run it from a clean clone](#run-it-from-a-clean-clone).

## See the UI

Three ways, each with its address:

1. The running app, after `docker compose up -d --wait`: http://localhost:3000/en/operator for the operator console,
   and the player widget through the launch link that `scripts/web-live-player.sh` prints. The app calls MIO's own
   services, with the simulated casinos behind them.
2. The design prototype, the first design version, with mock data and no backend:
   `cd design/prototype && pnpm install --ignore-workspace && pnpm dev`, then http://localhost:5173.
3. The Storybook design system (`packages/ui`): `pnpm install --frozen-lockfile && pnpm storybook`, then
   http://localhost:6006.

Ways 2 and 3 need Node 24 and pnpm; `scripts/setup.sh --dev` checks both. Screenshots of the live app are in
[`docs/screens/`](docs/screens/README.md).

## How AI was used

The code, tests and docs were written by AI coding agents (Claude Code) in separate roles: a spec author, a test
author who freezes the tests, a coder who may not change them, and a reviewer who tries to break the result and
re-applies a mutation for each claimed fix. A person set the scope and made the decisions listed in
[`docs/ai/`](docs/ai/README.md), and checked the output against the demo, the tests and the evidence. The agent
instructions are in [`prompts/`](prompts/).

## Reading guide

For the product and the decisions behind it start at [`AGENTS.md`](AGENTS.md) and [`docs/README.md`](docs/README.md).
The repository is a monorepo built from a monorepo starter and extended with tenancy, an event bus and idempotent
money handling. Status words used everywhere: **Built**, **Partial** (the core exists, the named part does not)
and **Next** (decided, not built). Decisions cited as D-<n> in tests and comments are resolved in
docs/decision-log.md. Known gaps are listed near the end, in [Known gaps and what comes next](#known-gaps-and-what-comes-next).

## Screens

Operator console and player widget screenshots are in [`docs/screens/README.md`](docs/screens/README.md). The
default shots are from the live stack (`*-live.png`); the casino on the other side is the bundled simulator, not a
real casino.

## Run it from a clean clone

You need Docker with compose v2 (`scripts/setup.sh` checks this and the demo tools). No account of any kind is needed: identity runs on the Firebase Auth Emulator,
the casinos are simulated, billing uses a fake payment provider. The first build downloads base images and
packages, so it needs network access once.

```sh
git clone https://github.com/maxml/ex-mio-games ex-mio-games
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
   chart. They are listed, with what is missing, in [Known gaps and what comes next](#known-gaps-and-what-comes-next).

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
rabbitmq        Up 57 seconds (healthy)   0.0.0.0:55672->5672/tcp, 0.0.0.0:15672->15672/tcp
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

### Several stacks at once

Each worktree can run its own stack. `scripts/stack-up.sh [--slot N]` takes the lowest free slot from a ledger
shared by all worktrees of the clone, writes `.env.stack` (project `mio-sN`, every host port shifted by `10*N`;
slot 0 is the defaults above), checks each port with a real bind and refuses, naming the holder, if another
program has one. Then it runs `docker compose up -d --wait`. To aim tests and the demo at the slot:

```sh
scripts/stack-up.sh
set -a; . ./.env.stack; set +a
pnpm test:compose && scripts/demo.sh
scripts/stack-down.sh            # down -v, frees the slot, removes .env.stack
scripts/stack-prune.sh [--yes]   # delete unused images (dry run without --yes)
```

Images are shared: every built service is `ex-mio/<service>:<tag>`, where the tag is a hash of the build inputs
(a dirty worktree adds the diff). Two slots at the same code run the same images, and `stack-up.sh` builds only
the images that are missing, one at a time. Set `MIO_HEAVY` to a wrapper command to prefix those builds.
`stack-down.sh` never removes images. `stack-prune.sh` removes `ex-mio/*` tags no live slot uses (keeping the
newest 2; `MIO_KEEP_TAGS=N` changes that), old per-project images (`demo-*`, `mio-sN-*`) and build cache older than 30 minutes. It skips any
image a container uses, and any created in the last 30 minutes. `stack-down.sh` offers it when the last slot goes.

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
back). The recorded run below includes C-8.

Recorded output of that script, captured from `scripts/demo.sh` on 2026-11-22 against the compose stack built
from commit `1aa98e0` (run suffix 56719). The run printed `DONE: 40 steps, 194 assertions passed, 0 recorded failure(s)`
and exited 0, including Part C cases C-1 to C-8. Secrets and tokens are shown as `<redacted>`; the `PASS` lines
and long bodies are trimmed (`...`); nothing else is edited. Each block names the demo steps it comes from.

Workflow setup, steps 2, 5, 7 and 8: sign-up, integration credentials (the environment is stated, D-29), the
reward API registration (D-27, D-30) and the published wheel and rule:

```text
> POST 4001/v1/operators/signup body={"tenant_name":"Casino demo-a-56719","slug":"demo-a-56719","email":"boss@demo-a-56719.test","password":"<redacted>"}
< 201 {"tenant":{"id":"01a20399-7faa-7964-9a44-e106e1db8b28","type":"operator","name":"Casino demo-a-56719","slug":"demo-a-56719","status":"active"},"user":{"id":"01a20399-7faa-7066-9d2d-366f8faef0c6","email":"boss@demo-a-56719.test","roles":["operator_admin"]}}
> POST 4001/v1/credentials [authorization: Bearer <redacted>] body={"platform":"casino-a","environment":"production"}
< 201 {"key_id":"key_01a203997faa79649a44e106e1db8b28_w--JyawQ9zas","api_key":"<redacted>","hmac_secret":"<redacted>"}
> PUT 4001/v1/operator/integrations/casino-a/reward-api [authorization: Bearer <redacted>] body={"environment":"production","base_url":"http://casino-sim:4004","api_key":"<redacted>"}
< 200 {"platform":"casino-a","environment":"production","base_url":"http://casino-sim:4004","has_api_key":true,"issue_deadline_ms":null}
> PUT 4002/v1/operator/wheel [authorization: Bearer <redacted>] body={"name":"Demo wheel","segments":[{"label":"200 coins","weight":6,"reward":{"type":"coins","amount":200}},...]}
< 200 {"id":"01a20399-813e-7210-a752-f594030b48c0","version":2}
> PUT 4002/v1/operator/rules [authorization: Bearer <redacted>] body={"name":"Deposit 20 EUR, 1 spin","min_amount_minor":2000,"currency":"EUR","spins":1}
< 200 {"id":"deposit","version":2}
```

Workflow steps 1-3 (demo steps 16, 17 and 20), a signed deposit from casino A (schema A, HMAC over
`timestamp.body`) and from casino B (schema B, signature inside the body). The casino simulator builds and
signs the webhook:

```text
> POST 4004/casino-a/__deposit body={"target_url":"http://engagement:4002/v1/integrations/demo-a-56719/events","secret":"<redacted>","player_id":"A-PLAYER-77","amount_minor":5000,"currency":"EUR","event_id":"evt-a-56719-1"}
< 200 {"delivered":[200]}
> POST 4004/casino-b/__deposit body={"target_url":"http://engagement:4002/v1/integrations/demo-b-56719/events","secret":"<redacted>","player_id":"B-PLAYER-12","amount_minor":5000,"currency":"EUR","event_id":"evt-b-56719-1"}
< 200 {"delivered":[200]}
> GET 4002/v1/me/spins [authorization: Bearer <redacted>]        (player A, after the rules engine ran over the bus)
< 200 {"available":1}
```

Workflow steps 4-5 (demo steps 24 and 25), the spin and the balance. The same Idempotency-Key replays the same
spin:

```text
> GET 4002/v1/wheel [authorization: Bearer <redacted>]
< 200 {"wheel_id":"01a20399-813e-7210-a752-f594030b48c0","segments":[{"label":"200 coins"},{"label":"300 coins"},{"label":"500 coins"}]}
> POST 4002/v1/spins [idempotency-key: spin-a-56719-1] body={}
< 201 {"spin_id":"e2db2218-34e5-8079-b6dc-98f8b8f4f17d","segment_index":2,"segment_label":"500 coins","reward_coins":500}
> POST 4002/v1/spins [idempotency-key: spin-a-56719-1] body={}
< 201 {"spin_id":"e2db2218-34e5-8079-b6dc-98f8b8f4f17d","segment_index":2,"segment_label":"500 coins","reward_coins":500}
> GET 4003/v1/me/balance [authorization: Bearer <redacted>]
< 200 {"wallet_id":"01a20399-e459-741c-bc03-7118046b196e","available":500,"held":0,"currency":"COIN"}
```

Workflow steps 6-8 (demo steps 28 to 30), the redemption and its final status. Casino A answers the bonus at
once; casino B answers with a ticket, the simulator settles it, and the order ends `ISSUED`:

```text
> POST 4002/v1/redemptions [idempotency-key: redeem-a-56719-1] body={"item_id":"01a20399-a3b6-7fed-a8c5-4f6bff8c1552"}
< 202 {"id":"01a20399-ed06-73b9-8fb6-614f20ae112f","item_id":"01a20399-a3b6-7fed-a8c5-4f6bff8c1552","price":50,"status":"pending","state":"RESERVED","attempts":0,"casino_reference":null,"failure_reason":null,"history":[],...}
> GET 4002/v1/redemptions/01a20399-ed06-73b9-8fb6-614f20ae112f
< 200 {"id":"01a20399-ed06-73b9-8fb6-614f20ae112f","price":50,"status":"issued","state":"ISSUED","attempts":1,"casino_reference":"bonus-43840e0a-951e-474d-ae09-49d5dd526c4a","failure_reason":null,"history":[],...}
> GET 4004/__issued?casino=a
< 200 [{"key":"redeem:01a20399-7faa-7964-9a44-e106e1db8b28:prd:01a20399-ed06-73b9-8fb6-614f20ae112f","player_id":"A-PLAYER-77","reference":"bonus-43840e0a-951e-474d-ae09-49d5dd526c4a","reward":{"type":"bonus","amount":500,"currency":"EUR"}}]

> POST 4002/v1/redemptions [idempotency-key: redeem-b-56719-1] body={"item_id":"01a20399-a46d-755b-bedb-22cd89a5be29"}
< 202 {"id":"01a20399-f706-74ce-b1d1-b67ccfe8aba1","price":50,"status":"pending","state":"RESERVED","attempts":0,...}
> GET 4004/__issued?casino=b
< 200 [{"key":"redeem:01a20399-844f-7409-8a45-2e7e02b047bb:prd:01a20399-f706-74ce-b1d1-b67ccfe8aba1","player_id":"B-PLAYER-12","reference":"tkt-e062a319-a032-4399-b710-a1b226a4561c","reward":{"type":"bonus","amount_cents":500,"ccy":"EUR"}}]
> POST 4004/casino-b/__settle
< 200 {"settled":1}
> GET 4002/v1/redemptions/01a20399-f706-74ce-b1d1-b67ccfe8aba1
< 200 {"id":"01a20399-f706-74ce-b1d1-b67ccfe8aba1","price":50,"status":"issued","state":"ISSUED","attempts":1,"casino_reference":"ref-7888bdb1-30ab-4317-82d7-edffe1b3ae64","failure_reason":null,"history":[],...}
> GET 4003/v1/me/balance [authorization: Bearer <redacted>]
< 200 {"wallet_id":"01a20399-e459-741c-bc03-7118046b196e","available":450,"held":0,"currency":"COIN"}      (player A: 500 minus the 50 coins of the order)
```

Part C cases from the same run (demo steps 32 to 39):

```text
# C-1 duplicate deposit: the casino delivers one webhook three times, the player gets one spin
> POST 4004/__faults body={"casino":"a","kind":"duplicateDelivery","times":1,"copies":3}
> POST 4004/casino-a/__deposit body={...,"event_id":"evt-a-56719-dup"}
< 200 {"delivered":[200,200,200]}
> GET 4002/v1/me/spins
< 200 {"available":1}

# C-2 concurrent spins: 10 parallel requests with distinct keys against one credit
< 1 201; 9 409;          then GET /v1/me/spins -> {"available":0}

# C-3 duplicate redemption: the same Idempotency-Key 5 times in parallel
< statuses:  1 202; 4 409;      one redemption id, coins debited once (900)
> POST 4002/v1/redemptions (same key again)
< 202 + header Idempotent-Replayed: true, same id 01a2039b-1479-7602-af22-8665c0f2f21c

# C-4 casino timeout: the casino accepts the bonus and never answers in time
> POST 4004/__faults body={"casino":"a","kind":"timeout","times":1,"player_id":"A-PLAYER-77"}
    state: RESERVED
    state: ISSUING
    state: UNKNOWN
    state: ISSUED
< three redemptions, three issued rewards on the casino: the timeout produced no second reward

# C-5 unsigned, wrongly signed, and other-tenant-signed events
> POST 4002/v1/integrations/demo-a-56719/events                       (no signature)
< 401 {"message":"signature check failed","code":"signature_missing"}
> POST ... x-a-signature: 0000...0000
< 401 {"message":"signature check failed","code":"signature_invalid"}
> POST ... x-a-signature: <valid HMAC with casino B's secret>
< 401 {"message":"signature check failed","code":"signature_invalid"}
> POST 4002/v1/spins   (no token)
< 401 {"code":"TENANT_REQUIRED","message":"authentication required"}

# C-6 player isolation: another player of casino A reads player A's data
> GET 4002/v1/redemptions/01a20399-ed06-73b9-8fb6-614f20ae112f
< 404 {"message":"redemption not found","code":"redemption_not_found"}
> GET 4003/v1/players/01a20399-a71e-722e-a0cb-13c2486a3258/balance
< 403 {"code":"forbidden","message":"role not allowed"}

# C-6b a player with no coins redeems: no negative balance
< 409 {"message":"not enough coins","code":"insufficient_funds"}
> GET 4003/v1/me/balance
< 404 {"code":"wallet_not_found","message":"wallet not found"}

# C-7 tenant isolation: casino B reads casino A's redemption
> GET 4002/v1/operator/redemptions/01a20399-ed06-73b9-8fb6-614f20ae112f   (casino B operator token)
< 404 {"message":"redemption not found","code":"redemption_not_found"}
> GET 4002/v1/redemptions/01a20399-ed06-73b9-8fb6-614f20ae112f            (casino B player token)
< 404 {"message":"redemption not found","code":"redemption_not_found"}
```

C-8, a failed reward issuance (demo step 40). Casino B is told to reject one bonus. The order holds the coins
while the casino's ticket is pending, then ends `RELEASED`; the balance returns to the baseline once, and the
stock unit and the per-player slot come back (the second order of the same one-unit item is accepted):

```text
> POST 4004/__faults body={"casino":"b","kind":"reject","times":1,"player_id":"B-PLAYER-12"}
    balance before: 150
> POST 4002/v1/redemptions [idempotency-key: redeem-b-56719-reject] body={"item_id":"01a2039b-6cfa-7d0d-94d3-b661832b34ed"}
< 202 {"id":"01a2039b-74bd-7451-b07a-f444636a39d8","price":50,"status":"pending","state":"RESERVED",...}
> GET 4002/v1/redemptions/01a2039b-74bd-7451-b07a-f444636a39d8
< 200 {"status":"pending","state":"UNKNOWN","attempts":1,"casino_reference":"tkt-809ac6a3-12b4-43b5-b6df-7cde68f2fa2c",...}
> GET 4003/v1/me/balance
< 200 {"available":100,"held":50,"currency":"COIN"}
> POST 4004/casino-b/__settle
< 200 {"settled":1}
> GET 4002/v1/redemptions/01a2039b-74bd-7451-b07a-f444636a39d8        (after the next poll, at most 60 s)
< 200 {"status":"failed_refunded","state":"RELEASED","attempts":1,"failure_reason":"casino_rejected:rejected","history":[],...}
> GET 4003/v1/me/balance
< 200 {"wallet_id":"01a20399-e916-7e68-9fa8-dbd9be393874","available":150,"held":0,"currency":"COIN"}
> GET 4004/__issued?casino=b
< 200 [ ...only the earlier bonus; the rejected one was never issued ]
> POST 4002/v1/redemptions [idempotency-key: redeem-b-56719-after-reject] body={"item_id":"01a2039b-6cfa-7d0d-94d3-b661832b34ed"}
< 202 {"id":"01a2039c-a229-7954-b158-384caf9da5c3","status":"pending","state":"RESERVED",...}
```

Realtime (demo steps 22, 23 and 26): one Socket.IO client on namespace `/rt` with a one-time ticket from
`POST /v1/auth/realtime-ticket`. The handshake and the namespace connect went through the web origin, the
WebSocket upgrade passed through the web proxy with and without the trailing slash, and the pushed frames
arrived:

```text
> POST 4001/v1/auth/realtime-ticket [authorization: Bearer <redacted>] body={}
< 200 {"ticket":"<redacted>","expires_in":60}
> GET /socket.io/?EIO=4&transport=websocket + Upgrade: websocket (web origin, trailing slash as the client sends it)
< HTTP/1.1 101 Switching Protocols
< 42/rt,["notification",{"id":"01a20399-e34d-786f-8b64-2a65931b0f57","type":"spin.result","payload":{"spin_id":"e2db2218-34e5-8079-b6dc-98f8b8f4f17d","reward_coins":500,"table_version":2},"ts":1795356746573}]
< 42/rt,["notification",{"id":"01a20399-e466-7730-9512-0e5f54a3ab8b","type":"balance.changed","payload":{"reason":"credited","amount":500},"ts":1795356746854}]
```

### Gaps the first recorded run exposed

An earlier recorded run (37 steps, 13 failures) exposed three gaps. All three are closed (decision D-27), and the
output above, from the run on `1aa98e0`, shows them closed: the redemption reaches the casino and ends `ISSUED`
or `RELEASED`, and the socket works through the web origin.

- **Socket.IO.** The web `/config` now returns `realtimeUrl` (engagement's public URL, `PUBLIC_REALTIME_URL`),
  engagement allows the web origin (`REALTIME_ALLOWED_ORIGINS`), and the same-origin `/socket.io` rewrite
  stays as a fallback with `skipTrailingSlashRedirect` so `/socket.io/` is no longer redirected.
- **Redemption reaching the casino.** An operator registers the casino reward API with
  `PUT /v1/operator/integrations/:casino/reward-api` (identity); it is served to engagement as `reward_api`.
  The URL is checked twice (D-30). The PUT refuses credentials in the URL and literal loopback, private,
  link-local (cloud metadata) and unspecified addresses. Engagement's transport resolves the host at call
  time and refuses the same ranges, never follows a redirect (a 3xx counts as "outcome unknown"), and in
  production requires `https`; identity's PUT applies the same shared rule (D-31): in a production
  deployment (`NODE_ENV=production`) a plain-http URL is refused for every reward API, sandbox or production.
  `REWARD_API_ALLOW_HOSTS` (comma separated host names,
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
through an idempotent inbox. Synchronous calls: engagement -> payments for every coin command of the saga
(reserve, capture, release, refund) and the balance read; engagement and payments -> identity for service tokens,
tenant status, integration secrets, player resolve/link and realtime-ticket redeem; engagement -> the casino reward
API; the web BFF -> all three services. Everything else is an event. Every service trusts only tokens identity
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
| `STRIPE_SECRET_KEY`                               | payments             | set only to select the Stripe stub, which throws on every call; the fake provider runs otherwise                 |
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

Engagement hosts the Socket.IO gateway (namespace `/rt`). The browser reads `realtimeUrl` from the web `/config`
(engagement's public URL, `PUBLIC_REALTIME_URL`) and opens the socket there; engagement allows the web origin
through `REALTIME_ALLOWED_ORIGINS`. The web app's same-origin `/socket.io/*` rewrite to engagement stays as a
fallback (decision D-27). The socket authenticates with a
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
| Payments against Postgres                                                           | `pnpm --filter @ex-mio/payments test:db`                                                                                                    | `docker compose up -d --wait` (see below)                      |
| Engagement store against Postgres                                                   | `pnpm --filter @ex-mio/engagement test:pg` with `DATABASE_URL` set (see below)                                                              | `docker compose up -d --wait` (see below)                      |
| Whole stack: health, roles, tenant isolation, idempotency, bus, ingest, saga, audit | `pnpm test:compose`                                                                                                                         | `docker compose up -d --wait` (the stack on its default ports) |
| Lint (layering, package boundaries)                                                 | `pnpm lint`                                                                                                                                 | nothing running                                                |
| Typecheck                                                                           | `pnpm typecheck`                                                                                                                            | nothing running                                                |
| Frontend layering                                                                   | `pnpm lint:fsd`                                                                                                                             | nothing running                                                |
| Design system in a browser                                                          | `pnpm storybook` (port 6006)                                                                                                                | nothing running                                                |

`pnpm test` (`nx run-many -t test`, one project at a time) on the release commit `2aa4b7a` (2026-11-22). All projects pass; the skipped tests are marked
skipped in the source, and the known-defect tests that are expected to fail are `it.failing`, counted as passed:

```text
@ex-mio/contracts     122 passed        @ex-mio/engagement    391 passed, 2 skipped
@ex-mio/tenancy        19 passed        @ex-mio/payments      181 passed
@ex-mio/logger         81 passed        @ex-mio/identity      274 passed
@ex-mio/bus            16 passed        @ex-mio/casino-sim     25 passed
@ex-mio/idempotency     6 passed        @ex-mio/ui             89 passed
@ex-mio/service-kit   160 passed, 5 skipped    @ex-mio/web    187 passed
```

`pnpm lint`, `pnpm typecheck`, `pnpm lint:fsd`, `pnpm format:check`, `tsc` for `tests/compose` and
`ci/check-prompts.sh` also pass on that commit.

The integration suites were run on a stack slot on 2026-11-22, on the same commit `2aa4b7a` (final run; the
output is in [`evidence/`](evidence/README.md): `compose.txt`, `pay-db.txt`, `eng-pg.txt`, `demo-run.txt`): `pnpm test:compose` 250 of 250 passed (18 suites),
`pnpm --filter @ex-mio/payments test:db` 181 of 181 passed (8 suites),
`pnpm --filter @ex-mio/engagement test:pg` 50 of 50 passed (4 suites), and `scripts/demo.sh` on a fresh slot passed
40 steps and 194 assertions with 0 failures, including Part C cases C-1 to C-8 against the live stack. The Part C
compose tests behind those cases are in `tests/compose/src/partc-issuance.compose.test.ts`. CI runs the same checks on every push to `main`: unit tests, lint and typecheck, then a
clean-clone compose stack with the compose tests, both database suites and the demo. Runs are listed on the
[Actions page](https://github.com/maxml/ex-mio-games/actions/workflows/ci.yml), and `9607734` has a green run: https://github.com/maxml/ex-mio-games/actions/runs/45056098182. The compose counts quoted in [`docs/ai/`](docs/ai/README.md) (98 then 107 of 111) are
reviewer-reported on an earlier tree; the run above supersedes them (S-11, S-12 and S-13 in
[`docs/submission/known-gaps.md`](docs/submission/known-gaps.md)).

Both Postgres suites need a database with the migrations applied, and the compose Postgres alone has none: each
service container applies its own migrations at start, so bring up the whole stack (`docker compose up -d --wait`,
as CI does). The roles are created by `docker/postgres/init.sh`: `<service>_app` (runtime, no DDL, row-level
security forced) and `<service>_owner` (migrations); the role `engagement` does not exist.

- `test:db` connects as `payments_app`, `payments_owner` and `postgres` itself, with the dev passwords from
  `init.sh` (`apps/payments/src/testing/pg.ts`). `POSTGRES_HOST` (default `localhost`) and `POSTGRES_PORT`
  (default `54329`) are the only variables.
- `test:pg` takes `DATABASE_URL` as the runtime role, and the schema must be applied by the owner role first
  (idempotent; the container did it at start, this repeats it):

  ```sh
  docker compose exec -T \
    -e MIGRATION_DATABASE_URL=postgresql://engagement_owner:engagement-owner-dev@postgres:5432/engagement \
    engagement node dist/migrate.js
  DATABASE_URL=postgresql://engagement_app:engagement-app-dev@localhost:54329/engagement \
    pnpm --filter @ex-mio/engagement test:pg
  ```

```text
$ pnpm lint
 NX   Successfully ran target lint for 13 projects
$ pnpm typecheck
 NX   Successfully ran target typecheck for 13 projects and 6 tasks they depend on
```

Money paths are tested with concurrency (parallel spins and reservations, parallel same-key requests), with a
kill at each durable step of the redemption, and with a one-million-spin distribution check. The map from each
reliability case to its tests is in [`docs/submission/part-c.md`](docs/submission/part-c.md). There is one stack per
slot (the default stack uses fixed host ports); use `scripts/stack-up.sh` to run more than one at a time, and
`docker compose down -v` to clean a stack.

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
- A deposit grants spins by a per-tenant rule. A new tenant gets a default rule and wheel on signup (D-27, see
  `docs/submission/known-gaps.md` G-4); the demo rule is "a deposit of at least 20.00 grants one spin", and an
  operator changes it with `PUT /v1/operator/rules`. No SQL seeding is needed on a fresh stack.
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

| Area                                                                                                      | Status                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Three domain services with a database each, plus web and casino-sim, one container each, one compose file | Built                                                                                                            |
| Tenancy: token claim, row-level security, separate owner and app roles, isolation tests                   | Built                                                                                                            |
| Two casino adapters, canonical model, adapter contract suite, simulator with fault injection              | Built                                                                                                            |
| Signed event ingestion, validation, deduplication, outbox and inbox, dead-letter replay                   | Built                                                                                                            |
| Rules engine, versioned reward table, server-side deterministic wheel                                     | Built                                                                                                            |
| Double-entry coin ledger, reserve, capture, release, refund, reconciliation job                           | Built (reports a mismatch, no pager)                                                                             |
| Bonus Store, redemption saga with recovery from unknown outcomes, operator review route                   | Built                                                                                                            |
| Identity: tokens, JWKS, RBAC, acting sessions with audit, service tokens, launch exchange                 | Built                                                                                                            |
| Operator signup and plan checkout against the fake provider                                               | Built                                                                                                            |
| Realtime push over Socket.IO with a one-time ticket                                                       | Built, at most once                                                                                              |
| Web: player widget and operator console                                                                   | Built; live against the services by default. Sandbox check, go-live and coin history are mock (see known gaps)   |
| Product events for Varta                                                                                  | Built: 12 events on stdout; ingest path verified against Varta's schema; reaches Varta when deployed with labels |
| Redis balance projection                                                                                  | Partial: wired, optional, off in default compose                                                                 |
| Missed-event replay on websocket reconnect                                                                | Next                                                                                                             |
| Rate limiting                                                                                             | Next                                                                                                             |
| Stripe payment provider                                                                                   | Next (interface and a stub that throws)                                                                          |
| Production identity provider, refresh tokens                                                              | Next                                                                                                             |
| Provably-fair seed commitment, RNG certification                                                          | Next                                                                                                             |
| Per-service deployment secrets                                                                            | Next, not claimed                                                                                                |
| Deckhand deploy                                                                                           | Built: blue-green deploy to a pre-production server, demo passed there (`docs/screens/ops`)                      |

## Where the answers are

| Part                                      | Answer                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A: architecture                           | [`docs/architecture/`](docs/architecture/README.md) (diagrams), [`overview.md`](docs/architecture/overview.md), [`docs/adrs/`](docs/adrs/) |
| B: working prototype                      | this README, the flows in [`docs/samples/`](docs/samples/), the service specs in [`docs/specs/`](docs/specs/)                              |
| C: reliability and security               | [`docs/submission/part-c.md`](docs/submission/part-c.md) and the reliability matrix in the overview                                        |
| D: AI-native development                  | [`docs/ai/`](docs/ai/README.md): process, decisions, defects found, verification                                                           |
| E: scaling, first 90 days, team           | [`docs/scaling/`](docs/scaling/README.md) and [`90-days.md`](docs/scaling/90-days.md)                                                      |
| What is missing                           | [`docs/submission/known-gaps.md`](docs/submission/known-gaps.md)                                                                           |
| The backlog (18 epics, tasks, acceptance) | [`backlog/`](backlog/README.md)                                                                                                            |

## Release notes

Upgrading: changes that need an action when you upgrade from an earlier tree (decisions D-29 and D-30 in
[`docs/decision-log.md`](docs/decision-log.md)).

- **Wire-key format changed: drain before you upgrade.** The idempotency keys that engagement sends to payments
  and to the casino, and the usage key sent to the billing provider, are now scoped by tenant and environment:
  `<kind>:<tenant id>:prd|sbx:<id>` (for example `hold:<tenant>:prd:<order id>`, `redeem:...`, `capture:...`,
  `usage:<tenant>:prd:<period>`), where the earlier format was `<kind>:<id>`. An order in flight across the
  upgrade would be looked up under a new key that the casino and payments have never seen, so no order may be in
  flight: let every redemption reach a final state first. Nothing is in flight before the first launch, which is
  why the change was accepted. Check that no redemption is `Pending`, `Held` or `Unknown`, then roll payments,
  engagement and identity together. The key format is pinned in `packages/contracts/src/scoped-key.ts` (D-26).
- **The environment is required, with no production default.** These requests now answer **400
  `VALIDATION_FAILED`** without `environment` (`production` or `sandbox`): `POST /v1/credentials` (body
  `{ platform, environment }`), `PUT /v1/operator/integrations/:casino/reward-api` (body `{ environment, base_url,
... }`) and the internal `GET /internal/v1/tenants/:tenantId/players/:playerId/balance` (query
  `sandbox=true|false`). An event without `sandbox` is invalid and goes to the dead-letter path. Callers that
  relied on the old default must now send the value.
- **The reward API must be https in production.** A plain-http reward API is refused by the PUT and by the call
  itself in production; the only exception is a host listed in `REWARD_API_ALLOW_HOSTS` (compose lists
  `casino-sim`). The PUT also refuses credentials in the URL and loopback, private, link-local and unspecified
  addresses, and the call never follows a redirect.
- **Migrations are forward only.** An applied migration is never edited: a change to a shipped table goes
  into a new migration (the `inbound_events` key and the `audit_intents` tenant isolation shipped that way).
  `node dist/migrate.js` exits 1 when the image ships no migrations.

## Known limitations

- The websocket has no missed-event replay; the client resyncs over REST.
- Stripe exists as an interface and a stub that throws on every call; the fake provider is what runs. The production identity provider is not chosen; there are no refresh tokens.
- The Deckhand deploy ran on a pre-production server (`docs/deploy.md`, `docs/screens/ops/`); Varta received the product events there (57 events of 10 kinds during the demo run). There is no production deployment.
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
  so it cannot run a repo script); `scripts/migrate-all.sh` is the same loop for a shell. The Deckhand deploy
  (only `web` public, no Redis, per-service secret mapping, project-built Postgres image, backup script) is described
  in `docs/deploy.md`.

## Operations

Each service has two database roles: `<service>_owner` (owns the schema, used by `migrate.js` only) and
`<service>_app` (runtime: not the owner, no DDL, exact grants listed in the `AppRoleGrants` migration).
Dead-lettered messages wait in `<service>.dlq`; after fixing the cause, re-drive them with
`node dist/dlq-replay.js [--dry-run] [--limit N] [--outbox]` in that service's container. Payments' worker
reconciles every tenant's ledger and reports usage on an interval; `pnpm --filter @ex-mio/payments ledger:report`
(`node dist/ledger-report.js`) runs one pass by hand and exits 1 on a mismatch.

## Next steps

1. Authenticated journal replay for realtime, and a Redis adapter for more than one engagement instance.
2. Provably-fair draws: publish a hash of the seed before play, reveal after rotation.
3. Stripe provider and hosted checkout; entitlements by plan. Refresh tokens and a production identity provider.
4. Rate limits per tenant; alerts on reconciliation and dead-letter depth.
5. Service routes for the sandbox check, go-live and reading the published rules and wheel back, so the console stops answering them from its mock.
6. Per-service deployment secrets and the blue-green rollout through Deckhand; observability through Varta.
7. Move integrations into their own service when a second operator team needs independent releases.

## Known gaps and what comes next

The slice is complete for the task flow. These are the gaps that matter most:

- Some console screens still answer from a mock in live mode: the sandbox check, go-live, coin history and the
  cross-tenant admin tables have no service route yet.
- There is no rate limiting, and performance is not measured: no load test, no latency figures, no SLOs.
- Realtime events are delivered at most once. A client that was offline resyncs over REST.
- Stripe is an interface and a stub that throws on every call, the production identity provider is not chosen, and
  the Deckhand deploy and Varta ingestion ran on pre-prod only; there is no production deployment.
- A few guards have no test that fails when the wiring is cut, and log redaction has known holes.

The full list is [`docs/submission/known-gaps.md`](docs/submission/known-gaps.md), with a summary table at its top.
The follow-up tasks (MIO-193 to MIO-218) are in [`backlog/`](backlog/README.md). The ordered next steps are above
under "Next steps".

## How this was built

Planned and built with AI coding agents under a review framework (review-framework, a set of review rules kept by the product owner, not a dependency of
this repository) that requires a regression test at the choke point and a re-applied mutation for every claimed
fix. The rules are restated in [`docs/ai/verification.md`](docs/ai/verification.md). The service skeleton comes from the
monorepo starter. Evidence, and the decisions made by hand, are in [`docs/ai/`](docs/ai/README.md).

## License

MIT, see [`LICENSE`](LICENSE).
