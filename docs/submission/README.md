# MIO Games (ex-mio-games)

A working vertical slice of a multi-tenant engagement platform for online casinos. A casino sends a signed deposit event, the player earns a Wheel of Fortune spin, spins it for a server-decided coin reward, and redeems coins for a Bonus Store reward that MIO Games asks the casino to issue. Two simulated casinos with different event and reward APIs run through the same internal logic.

This file is the draft of the final root README. Claims that depend on code not yet merged into the main branch carry the marker `<!-- verify after integration -->`; remove each one only after checking it against the merged code.

## Quickstart

You need Docker with compose v2. Running the stack needs no account of any kind; running the tests also needs Node 24 and pnpm 9.

```sh
git clone --recurse-submodules <repository-url> ex-mio-games   # submodules: the architecture diagram renderer
cd ex-mio-games
cp .env.example .env            # local-development values only
docker compose up --wait        # builds the images, waits until every container is healthy
```

<!-- verify after integration: `.env.example` exists; `--wait` returns only when all nine containers are healthy -->

Then run the demo, which plays the 8-step workflow against the running stack for both casinos and prints each response:

```sh
pnpm demo        # TODO: the demo script does not exist yet; it lands with the integration
```

<!-- verify after integration: script name, output, and that docs/samples/*.http responses are replaced by its captured output -->

Until the script exists, [`docs/samples/`](../samples/) has every request of the workflow as `.http` files.

| Container | Host port | Purpose |
| --- | --- | --- |
| `web` | 3000 | player widget and operator console |
| `identity` | 4001 | tenants, users, tokens, player mapping |
| `engagement` | 4002 | casino adapters, rules, wheel, Bonus Store, redemption saga |
| `payments` | 4003 | the coin ledger and the operator's plan billing |
| `casino-sim` | 4004 | the two simulated casinos, with fault injection |
| `postgres` | 54329 | one database and one non-superuser role per service |
| `rabbitmq` | 55672 (UI 15672) | event bus |
| `redis` | 56379 | cache, append-only persistence |
| `firebase-auth` | 9099 | the Firebase Auth Emulator (project `demo-ex-mio`) |

Infrastructure ports are not the defaults, so a database already running on your machine does not collide. Each port can be overridden by the variable named in `docker-compose.yml`. Stop and delete the data with `docker compose down -v`.

## Architecture in brief

Three services protect something expensive to get wrong; everything else is a module behind a boundary.

- `payments` is the only writer of coins. One owner makes the money invariants testable in one place.
- `identity` is the trust boundary. It signs tokens, holds tenants and the player mapping.
- `engagement` holds the business logic and may fail independently of money.
- Services talk over RabbitMQ with a transactional outbox and an idempotent inbox, plus a few synchronous internal calls (the coin reserve for a redemption).
- Tenant data is isolated by the token's tenant claim, scoped queries and Postgres row-level security.
- Casino differences live in adapters behind one port and one canonical event model.

Diagrams, the written explanation and the decisions behind them: [`docs/architecture/`](../architecture/README.md) (overview in [`overview.md`](../architecture/overview.md), decisions in [`docs/adrs/`](../adrs/)). <!-- verify after integration: links resolve on the merged branch -->

## Assumptions

- Both casinos are simulated. They implement two different wire protocols (casino A signs headers with a timestamp, casino B signs inside the body; casino A can look up a reward by our key, casino B only by ticket). No real casino API is called.
- The operator's plan billing runs against a fake payment provider by default (test cards only). The Stripe adapter is a stub that throws until configured.
- Identity uses the Firebase Auth Emulator, one tenant per MIO tenant, so the same email can register in two tenants.
- Coins are virtual, whole numbers, with no cash value. Amounts from casinos are integers in minor units; a float is rejected.
- A deposit grants spins by a configurable per-tenant rule; the demo rule is "a deposit of at least 20.00 grants one spin".
- The reward table, store items and rules are configured by the tenant operator. Odds changes are versioned.
- Access tokens last 15 minutes. Refresh tokens are not built.
- No independent RNG certification and no production infrastructure.
- All credentials in the repository are local-development values.

## What is built and what is designed only

Status is taken from the architecture overview and the service specs. The "Built" rows are code on feature branches that are being merged. <!-- verify after integration: every row below against the merged main -->

| Area | Status |
| --- | --- |
| Five services, one container and one database each, one compose file | Built |
| Tenancy: token claim, row-level security, isolation tests | Built |
| Two casino adapters, canonical model, adapter contract suite, casino simulator with fault injection | Built |
| Signed event ingestion, validation, deduplication, outbox and inbox | Built |
| Rules engine, versioned reward table, server-side deterministic wheel | Built |
| Double-entry coin ledger, reserve and capture and release and refund, reconciliation job | Built |
| Bonus Store and redemption saga with recovery from unknown outcomes | Built |
| Identity: tokens, JWKS, RBAC, acting sessions with audit, service tokens | Built |
| Operator signup and plan checkout against the fake provider | Built |
| Web: player widget and operator console | Built, minimal and not polished <!-- verify after integration --> |
| Demo script and recorded sample responses | Not yet built (TODO) |
| Stripe payment provider | Designed (interface only) |
| Websocket replay of missed events | Designed (live push built, replay not) |
| Production identity provider | Designed (choice open) |
| Refresh tokens | Designed |
| Provably-fair seed commitment, RNG certification | Designed |
| Moving a module (for example integrations) into its own service | Designed |
| Per-service deployment secrets | Designed, not claimed |
| Changes inside Varta and the Deckhand rollout | Designed |

## Tests

```sh
pnpm install --frozen-lockfile
pnpm test                       # unit and contract tests, no database needed
docker compose up -d --wait postgres
pnpm --filter @ex-mio/payments test:db      # database tests that need Postgres
docker compose up -d --wait
pnpm test:compose               # health, roles, tenant isolation, idempotency, bus, ingest, saga against the real stack
```

<!-- verify after integration: the scripts above exist; the db-test script name per service; the green counts -->

Money paths are tested with concurrency (50 parallel spins and reservations, 20 parallel same-key requests), with a kill at each durable step of the redemption, and with a one-million-spin distribution check. The map from each reliability case to its tests is in [`part-c.md`](part-c.md).

## Where the answers are

| Part | Answer |
| --- | --- |
| A: architecture | [`docs/architecture/`](../architecture/README.md), [`overview.md`](../architecture/overview.md), [`docs/adrs/`](../adrs/) |
| B: working prototype | this README (quickstart), the `.http` flows in [`docs/samples/`](../samples/), the service specs in `docs/specs/` <!-- verify after integration --> |
| C: reliability and security | [`part-c.md`](part-c.md), and the reliability matrix in the architecture overview |
| D: AI-native development | `docs/ai/` (evidence log, agent instructions, review lessons) <!-- verify after integration: path --> |
| E: scaling the product, first 90 days, team | `docs/scaling/` <!-- verify after integration: path --> |

## Known limitations

- The Wheel's tenant rule cap (`max_grants_per_player`) is best effort when two deposits of one player are processed in parallel; only the sequential case is pinned.
- Balance reads come from a cache and are briefly behind the ledger after a spin. Money commands always read Postgres.
- A casino that cannot look up a reward by our key and has no idempotent replay leaves the redemption in operator review; the operator's word alone never moves coins.
- No missed-event replay on websocket reconnect: the client resyncs over REST.
- No refresh tokens; an expired token needs a new login or launch.
- The Stripe adapter, rate limiting beyond the basics, and a real KYC or responsible-gaming layer are out of scope.
- The reconciliation job reports mismatches and never repairs them.
- Erasure removes the player-to-wallet link; whether the pseudonymous player id must also be erased from events already consumed is an open question.
- The first live run on one machine has not been recorded by a second person yet. <!-- verify after integration -->

## Next steps

1. Record the demo and replace the expected sample responses with captured output.
2. Provably-fair draws: publish a hash of the seed before play, reveal after rotation.
3. Stripe adapter and hosted checkout; entitlements by plan.
4. Refresh tokens and the authenticated journal replay for realtime.
5. Move integrations into their own service when a second operator team needs independent releases.
6. Per-service deployment secrets and the blue-green rollout through Deckhand; observability through Varta.
7. Dead-letter replay tooling and an operator adjustment path with audit.

## How this was built

Planned and built with AI coding agents under a review framework (review-framework) that requires a regression test at the choke point and a re-applied mutation for every claimed fix. The service skeleton comes from the monorepo starter. Evidence and the decisions made by hand are in `docs/ai/`. <!-- verify after integration -->
