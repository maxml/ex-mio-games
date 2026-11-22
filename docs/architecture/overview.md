# MIO Games architecture overview

This answers Part A of the brief. Diagrams are in [README.md](README.md). Decisions and their trade-offs are in [`docs/adrs/`](../adrs/).

Legend used throughout: **Built** means implemented in the submission and checked against the code. **Partial** means the core is implemented and the stated part is not. **Next** means described and decided, not implemented (older text calls this "Designed").

## 1. Shape of the system

Five deployables, each in its own container, plus infrastructure:

| Part         | Owns                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`   | authentication, authorization, the tenants module, JWT and JWKS, player identity mapping                                                             |
| `engagement` | ingestion, the integrations module (casino adapters), rules engine, wheel, Bonus Store, redemption saga, the Socket.IO gateway (namespace `/rt`)     |
| `payments`   | the coin ledger, coin operations, payment provider (`fake`), operator tariff                                                                         |
| `web`        | player widget and operator console                                                                                                                   |
| `casino-sim` | two simulated casino platforms with fault injection                                                                                                  |
| RabbitMQ     | domain events between services (ADR 0003)                                                                                                            |
| Postgres     | one database per service, RLS on tenant data                                                                                                         |
| Redis        | optional balance projection cache for read APIs, and a health probe; persistence on. Rate-limit counters and a websocket journal are next, not built |
| Varta        | observability and product analytics (external project; wiring described, not run here)                                                               |
| Deckhand     | blue-green deployment (external project; a manifest exists, no deploy was run here)                                                                  |

## 2. Modules versus services, and why

Services exist where a boundary protects something expensive to get wrong:

- `payments` is the only writer of coins. One owner makes the money invariants testable in one place.
- `identity` is the trust boundary: it signs tokens and holds personal data.
- `engagement` holds the business logic and is allowed to fail independently of money.

Everything else is a module behind an Nx boundary: tenants inside `identity`, integrations inside `engagement`, rules, wheel and store inside `engagement`. Tenants are read on every request and change rarely, so a network hop gains nothing. Integrations react to domain events that already live in `engagement`. A module can be promoted to a service by moving it, because other code imports only its public contract. Cost of the split, and what we did not split, is in ADR 0001.

## 3. Multi-tenancy (ADR 0002)

- Operators are tenants; the platform admin console is the `platform` tenant. Acting in an operator tenant needs an explicit `acting_tenant` that is audited. No implicit "no tenant means all".
- A user is `(tenant_id, user_id)`. A player does not pick a tenant; on a new tenant they register again, and email is unique per tenant.
- One database per service, shared across tenants. `tenant_id` on every table, composite primary and foreign keys, RLS with `USING` and `WITH CHECK`, `FORCE`d, set per transaction by `SET LOCAL app.tenant_id`. The application role is not superuser, not owner, `NOBYPASSRLS`.
- AsyncLocalStorage carries the tenant in a request; a repository without context throws. Redis keys and broker envelopes carry `tenant_id`, and consumers restore the context.
- The tenant comes from the verified launch token or session key, never from a header, body field or Referer.
- Tests: tenant-isolation tests at the service entry point and against Postgres (compose), DB-role and RLS-catalog tests, and one mutation per guard.
- Redis keys of the balance projection carry the tenant; broker envelopes carry `tenant_id`, and consumers restore the context.
- Next: moving a large tenant to its own database, per-tenant restore.

## 4. Integration adapters and the canonical model (ADR 0008)

Each casino has its own signature scheme, event schema and reward API. An adapter in the integrations module translates inbound events to a canonical event and outbound reward requests from a canonical command. Rules, wheel, store and ledger see only canonical types. Each adapter declares native lookup by our key or guaranteed idempotent replay, because lost-reply recovery depends on it. One contract suite runs against every adapter. Built: two adapters for the simulated casinos. The webhook signature is each casino's own scheme, verified in the engagement adapters; identity holds the secrets and serves them to engagement over an allow-listed internal route. Each integration credential carries `environment: sandbox|production`, and the `sandbox` flag of an event comes from that credential, never from client input. Next: a third adapter and operator self-service onboarding.

## 5. Identity mapping (ADR 0007)

A casino knows a player by its own id. `identity` maps `(tenant, platform, external_player_id)` to our `user_id` and is the only writer of the mapping (`resolveOrCreatePlayer`). Both `(tenant, platform, external_player_id)` and `(tenant, user_id)` are unique. A casino launch token is verified against the tenant's key and exchanged once for our own short-lived player JWT (audiences `identity`, `engagement`, `payments`; access token lifetime 15 minutes, no refresh token). Keys are published through JWKS and other services verify tokens locally. Players do not use the identity provider: they exist only as the casino's launch token plus our mapping. Staff and operators sign in through the identity provider, which sits behind an interface and is backed by the Firebase Auth Emulator, one provider tenant per MIO tenant. The production provider is not chosen (Built: interface, emulator, launch exchange; Next: production provider, refresh tokens).

## 6. Ingestion, validation, deduplication

1. The adapter verifies an HMAC over the body with a timestamp window (secret per tenant, rotatable). Unsigned or stale events are rejected.
2. The payload is validated against the adapter's schema. Invalid events are rejected and counted.
3. Deduplication is `UNIQUE (tenant, source, external_event_id)`; a duplicate deposit returns the original result and creates no second spin.
4. The canonical event, the effect (a spin credit) and the outbox row commit in one transaction. Consumers use an inbox so redelivery changes nothing.

Rejections are answered with a code and written to the log with the tenant slug; there is no rejection counter metric yet (Partial). The row keeps a per-tenant HMAC of the casino's player id, never the raw id.

## 7. Rules engine

A rule maps a canonical event to an effect under conditions (for example: deposit at or above a threshold grants one spin). Rules are tenant configuration, versioned, and evaluated deterministically in `engagement`. A rule never talks to a casino. The submission ships the deposit-triggers-spin rule; missions and PvP would add rules and effects without touching adapters (Designed).

## 8. Wheel and anti-manipulation (ADR 0005)

- Outcome is `HMAC(server_seed[version], spin_id)` reduced without modulo bias and looked up in a versioned weight table. The table version and seed version are stored with the result, so any outcome can be recomputed by an auditor.
- The client sends no weights, seed or outcome and receives only the result. Weights are never exposed.
- A spin credit exists only as the effect of a validated, deduplicated event; no player-facing API creates one.
- Consuming a credit is a single conditional update; with N concurrent requests, one wins. The endpoint authorizes that the credit belongs to the authenticated player in the verified tenant.
- Engagement never credits coins. It writes `engagement.spin.completed` to its outbox in the spin's transaction; `payments` consumes it through its inbox and credits with the key `spin:<spin_id>`, so a retry cannot pay twice. The spin response carries the reward, not the new balance, and the balance is eventually consistent.
- Spin credits are per environment: a sandbox token cannot consume a production credit.
- Rate limits per tenant, principal and IP are next, not built.

## 9. Ledger (ADR 0004)

- A balanced double-entry journal (`journal_transactions`, `ledger_entries`): a transaction has two or more entries, debits equal credits (deferred constraint trigger), amounts in integer minor units. Business uniqueness is `(tenant, operation_type, operation_id)`, with the operation types `spin_award`, `reserve`, `capture`, `release`, `refund`.
- Append-only: the application role has only SELECT and INSERT on `ledger_entries` and `journal_transactions`; a balance row may change only its amount and a reserve only its state (column-level grants).
- No negative balances: a conditional update `WHERE balance >= :amount` plus `CHECK (balance >= 0)`; concurrent debits cannot both pass.
- Operations (spin award from an event, reserve, capture, release, refund) go only through `payments`; there is no credit route. An acting (support) token is refused on every coin route, and operators cannot mint. Command paths read balances from Postgres; the Redis projection serves read APIs only and is optional (off in the default compose file).
- Reconciliation compares entries to balances and checks conservation. A periodic job in the payments worker and the CLI `node dist/ledger-report.js` run it; a mismatch is reported (the CLI exits 1) and never repaired. There is no pager integration, so "alert" means the run record and the exit code (Partial).

## 10. Redemption (ADR 0006)

An orchestrated saga in `engagement`. States: `REQUESTED`, `RESERVED`, `ISSUING`, `ISSUED`, `COMPLETED`, plus `REJECTED_FUNDS`, `REJECTED`, `RELEASED`, `REFUNDED`, `UNKNOWN`, `NEEDS_REVIEW`. The order reserves stock and the per-player limit; the coin reserve is a synchronous internal call to `payments` (key `hold:<id>`), so an unaffordable order answers 409 `insufficient_funds` immediately. `ISSUING` is committed before the adapter is called, then the adapter issues, then payments captures (`capture:<id>`). Keys are per phase (`hold:`, `capture:`, `release:`, `refund:`) and the client's `Idempotency-Key` is scoped to tenant, player and operation; a changed body is 422. A timeout moves to `UNKNOWN` and a sweeper asks the casino by our key (native lookup for casino A, idempotent replay for casino B) before deciding; coins are not released while the reward may exist. After a final refusal the saga releases the coins and returns stock exactly once. Retries use backoff, at most 8 attempts or 24 hours, then `NEEDS_REVIEW`. The player sees four words (`pending`, `issuing`, `issued`, `failed_refunded`) through the API and over the websocket. The review workflow is built as an operator route (`POST /v1/operator/redemptions/:id/resolve`); the operator's word alone never moves coins, an `issued` resolution captures only after a status lookup by our key returns `issued`. Next: tooling and a runbook for review queues at volume.

## 11. Admin configuration

The operator console (in `web`, backed by `identity`, `engagement` and `payments`) manages per-tenant settings. Built: Bonus Store catalog and stock (`/v1/store/items`), integration credentials with rotation, staff, plan billing, and the audit trail. Rules and reward tables are versioned in the database and read by the engine, but there is no service route to publish a new version yet, so the console answers those calls from its mock adapter (see `docs/submission/known-gaps.md`, G-4). Rate limits are next. Platform admins act on a tenant only through `acting_tenant`, which needs a reason of 8 to 500 characters, and every such request is written to the audit log (Built).

## 12. Observability, audit, security

- **Observability.** Structured JSON logs with redaction go to stdout, where Varta collects them. Partial: the product-event line contract (matching Varta's schema, with a conformance test) and its logger function are built, but no service calls it yet, so no product event is emitted. Next: emit business events through the outbox, and changes inside Varta (separate stream, longer retention). Wiring to a running Varta is described, not run here.
- **Audit.** An append-only audit log in `identity`. Every request that carries `acting_tenant`, allowed or refused, is audited through an `audit_intents` table (fail closed with 503 if the intent cannot be written) and an `audit.acting_request` event that identity consumes. The decision records the authorization outcome, not the HTTP status. Personal data stays in `identity`, so erasure never edits audit rows.
- **Security.** Casino webhook signatures in the adapters; RS256 JWT with JWKS; service tokens with an audience and route allow-list per client (a forged `x-tenant-id` is ignored everywhere); RBAC through a permission guard; zod validation on controllers; secrets redacted at the logger; fail-fast configuration; separate owner and app database roles. Rate limiting is next, not built.
- **Honest limit.** Isolation of services at deployment level, in particular per-service secret delivery, is designed only and is not claimed. Database-level isolation is built and tested.

## 13. Reliability matrix (Part C)

| Scenario                             | Mechanism                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Duplicate deposit event              | unique key on `(tenant, source, external_event_id)`; one spin                     |
| Concurrent spin requests             | conditional update on the credit; one winner                                      |
| Duplicate redemption                 | scoped `Idempotency-Key` with request hash; per-phase keys                        |
| External API timeout                 | `UNKNOWN` state, lookup by our key, no premature release                          |
| Failed reward issuance               | final refusal releases the hold and returns stock                                 |
| Retries and recovery                 | backoff, sweeper, maximum age, `NEEDS_REVIEW`                                     |
| Tenant isolation                     | RLS, composite keys, ALS, generated suite, mutations                              |
| Invalid or unauthorized events       | HMAC, timestamp window, schema, rejection codes and log lines (no counter metric) |
| No negative balance or double reward | database constraints and per-operation keys                                       |

## 14. Built versus designed

| Item                                                                                          | Status                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Five services, container each, DB each                                                        | Built                                                     |
| Tenancy with RLS, isolation tests                                                             | Built                                                     |
| Two casino adapters, canonical model, contract suite                                          | Built                                                     |
| Ledger, reserves, reconciliation job                                                          | Built (reconciliation reports, no pager)                  |
| Wheel with versioned weights and server RNG                                                   | Built                                                     |
| Redemption saga with lost-ticket recovery and operator review                                 | Built                                                     |
| Identity interface with Firebase Auth Emulator                                                | Built (staff and operators; players use the launch token) |
| Realtime push (Socket.IO gateway in engagement, one-time ticket, rooms per tenant and player) | Built, at most once                                       |
| Websocket replay of missed events                                                             | Next (client resyncs over REST)                           |
| Product events on stdout (Varta contract)                                                     | Partial (contract and logger built, no service emits yet) |
| Redis balance projection                                                                      | Partial (wired and optional, off in default compose)      |
| Rate limiting, Redis counters                                                                 | Next                                                      |
| Operator console writes for rules and wheel versions                                          | Partial (reads real, publish calls mocked)                |
| Stripe payment provider                                                                       | Next (interface and a stub that throws; `fake` is built)  |
| Production identity provider, refresh tokens                                                  | Next                                                      |
| Per-service deployment secrets                                                                | Next, not claimed                                         |
| Deckhand deploy, Varta wiring                                                                 | Described, not run here                                   |
| Changes inside Varta                                                                          | Next                                                      |
| Moving a module to its own service                                                            | Next                                                      |
