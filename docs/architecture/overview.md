# MIO Games architecture overview

This answers Part A of the brief. Diagrams are in [README.md](README.md). Decisions and their trade-offs are in [`docs/adrs/`](../adrs/).

Legend used throughout: **Built** means implemented in the submission. **Designed** means described and decided, not implemented.

## 1. Shape of the system

Five deployables, each in its own container, plus infrastructure:

| Part | Owns |
|---|---|
| `identity` | authentication, authorization, the tenants module, JWT and JWKS, player identity mapping |
| `engagement` | ingestion, the integrations module (casino adapters), rules engine, wheel, Bonus Store, redemption saga |
| `payments` | the coin ledger, coin operations, payment provider (`fake`), operator tariff |
| `web` | player widget and operator console |
| `casino-sim` | two simulated casino platforms with fault injection |
| RabbitMQ | domain events between services (ADR 0003) |
| Postgres | one database per service, RLS on tenant data |
| Redis | cache, rate-limit counters, websocket journal; persistence on |
| Varta | observability and product analytics (external project) |
| Deckhand | blue-green deployment (external project) |

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
- Tests: a generated isolation suite per repository, DB-role tests, and one mutation per guard.
- Designed: moving a large tenant to its own database, per-tenant restore.

## 4. Integration adapters and the canonical model (ADR 0008)

Each casino has its own signature scheme, event schema and reward API. An adapter in the integrations module translates inbound events to a canonical event and outbound reward requests from a canonical command. Rules, wheel, store and ledger see only canonical types. Each adapter declares native lookup by our key or guaranteed idempotent replay, because lost-reply recovery depends on it. One contract suite runs against every adapter. Built: two adapters for the simulated casinos. Designed: a third adapter and operator self-service onboarding.

## 5. Identity mapping (ADR 0007)

A casino knows a player by its own id. `identity` maps `(tenant, platform, external_player_id)` to our `user_id` and is the only writer of the mapping (`resolveOrCreatePlayer`). Both `(tenant, platform, external_player_id)` and `(tenant, user_id)` are unique. A casino launch token is verified against the tenant's key, exchanged for our short-lived JWT, and published through JWKS; other services verify it locally. The identity provider sits behind an interface, backed by the Firebase Auth Emulator now. The production provider is not chosen (Built: interface and emulator; Designed: production provider).

## 6. Ingestion, validation, deduplication

1. The adapter verifies an HMAC over the body with a timestamp window (secret per tenant, rotatable). Unsigned or stale events are rejected.
2. The payload is validated against the adapter's schema. Invalid events are rejected and counted.
3. Deduplication is `UNIQUE (tenant, source, external_event_id)`; a duplicate deposit returns the original result and creates no second spin.
4. The canonical event, the effect (a spin credit) and the outbox row commit in one transaction. Consumers use an inbox so redelivery changes nothing.

## 7. Rules engine

A rule maps a canonical event to an effect under conditions (for example: deposit at or above a threshold grants one spin). Rules are tenant configuration, versioned, and evaluated deterministically in `engagement`. A rule never talks to a casino. The submission ships the deposit-triggers-spin rule; missions and PvP would add rules and effects without touching adapters (Designed).

## 8. Wheel and anti-manipulation (ADR 0005)

- Outcome is `HMAC(server_seed[version], spin_id)` reduced without modulo bias and looked up in a versioned weight table. The table version and seed version are stored with the result, so any outcome can be recomputed by an auditor.
- The client sends no weights, seed or outcome and receives only the result. Weights are never exposed.
- A spin credit exists only as the effect of a validated, deduplicated event; no player-facing API creates one.
- Consuming a credit is a single conditional update; with N concurrent requests, one wins. The endpoint authorizes that the credit belongs to the authenticated player in the verified tenant.
- The reward is credited with the spin id as the operation id, so a retry cannot pay twice.
- Rate limits apply per tenant, principal and IP.

## 9. Ledger (ADR 0004)

- A balanced double-entry journal: a transaction has two or more legs, debits equal credits, one currency, amounts in integer minor units. Business uniqueness is `(tenant, operation_type, operation_id)`.
- Append-only: the application role has no update or delete on legs.
- No negative balances: a conditional update `WHERE balance >= :amount` plus `CHECK (balance >= 0)`; concurrent debits cannot both pass.
- Operations (credit, debit, refund, hold) go only through `payments`. Balance is readable from anywhere through a read API or projection.
- Reconciliation compares legs to balances and checks conservation; a mismatch raises an alert and is not silently repaired.

## 10. Redemption (ADR 0006)

An orchestrated saga in `engagement`: reserve stock and per-player limit, hold coins in `payments`, request issuance through the adapter, then capture and complete. Keys are per phase (`hold:`, `capture:`, `release:`, `refund:`) and the client's `Idempotency-Key` is scoped to tenant, principal and operation. A timeout moves to `UNKNOWN` and a worker asks the casino by our key before deciding; coins are not released while the reward may exist. Failure after a final refusal releases the hold and returns stock. Retries use backoff with a maximum age, then `NEEDS_REVIEW`. The final status is exposed through an API and pushed over a websocket. Designed: the review workflow behind `NEEDS_REVIEW`.

## 11. Admin configuration

The operator console (in `web`, backed by `identity` and `engagement`) manages per-tenant settings: reward and weight tables (versioned), rules, Bonus Store catalog and stock, adapter secrets and rotation, and rate limits. Platform admins act on a tenant only through `acting_tenant`. Every change is written to the audit log. Weight and rule changes create a new version; the past stays explainable.

## 12. Observability, audit, security

- **Observability.** Structured logs with correlation, tenant and trace ids go to Varta. Product events follow one contract (ADR 0009): business events via the outbox, at least once, counted by distinct `event_id`; behavioural events best effort. Built: events on stdout under Varta's contract. Designed: changes inside Varta (separate stream, longer retention).
- **Audit.** An append-only audit log of privileged actions, written in the same transaction as the change; personal data stays in `identity`, so erasure never edits audit rows.
- **Security.** HMAC on inbound casino calls; JWT with JWKS between services; RBAC with a `can` check; rate limiting; zod validation on every controller; secrets never logged (redaction at the logger); fail-fast configuration.
- **Honest limit.** Isolation of services at deployment level, in particular per-service secret delivery, is designed only and is not claimed. Database-level isolation is built and tested.

## 13. Reliability matrix (Part C)

| Scenario | Mechanism |
|---|---|
| Duplicate deposit event | unique key on `(tenant, source, external_event_id)`; one spin |
| Concurrent spin requests | conditional update on the credit; one winner |
| Duplicate redemption | scoped `Idempotency-Key` with request hash; per-phase keys |
| External API timeout | `UNKNOWN` state, lookup by our key, no premature release |
| Failed reward issuance | final refusal releases the hold and returns stock |
| Retries and recovery | backoff, sweeper, maximum age, `NEEDS_REVIEW` |
| Tenant isolation | RLS, composite keys, ALS, generated suite, mutations |
| Invalid or unauthorized events | HMAC, timestamp window, schema, rejection counters |
| No negative balance or double reward | database constraints and per-operation keys |

## 14. Built versus designed

| Item | Status |
|---|---|
| Five services, container each, DB each | Built |
| Tenancy with RLS, isolation suite | Built |
| Two casino adapters, canonical model, contract suite | Built |
| Ledger, holds, reconciliation | Built |
| Wheel with versioned weights and server RNG | Built |
| Redemption saga with lost-ticket recovery | Built |
| Identity interface with Firebase Auth Emulator | Built |
| Analytics events on stdout (Varta contract) | Built |
| Stripe payment provider | Designed (interface only; `fake` is built) |
| Websocket replay of missed events | Designed (live push is built, journal replay is not) |
| Production identity provider | Designed (choice open) |
| Per-service deployment secrets | Designed, not claimed |
| Changes inside Varta | Designed |
| Moving a module to its own service | Designed |
