# 0001. Microservices, where the boundaries are, and what they cost

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: medium-high for the boundaries, medium for the number of services

## Context and problem statement

MIO Games must be a multi-tenant SaaS that two (later ten) casino operators plug into. The brief asks which components start as modules and which need independent services. Everything here is built in two days, so every extra service has a direct cost in setup, tests and debugging.

## Decision drivers

- Money must have one writer with the strictest invariants (balanced journal, no negative balance).
- The identity trust boundary (token signing, tenants, roles) must not leak into product code.
- A failure in a casino integration must not take the ledger down.
- Growth is expected, and splitting a monolith later is costlier than starting split along stable seams.
- Operating cost must stay small enough for a team of three to four.

## Considered options

1. Modular monolith, split later.
2. Three domain services (identity, engagement, payments) plus web and a casino simulator.
3. One service per module (tenants, integrations, rules, wheel, store, ledger, billing).

## Decision outcome

Option 2. Services: `identity` (authN, authZ, tenants module), `engagement` (ingestion, integrations module, rules, wheel, store, redemption saga), `payments` (ledger, coin operations, payment provider, operator tariff), `web`, and `casino-sim` (two simulated operators). Each service has its own Postgres database and its own container.

Tenants stay a module inside `identity`, and casino integrations stay a module inside `engagement`. Both are the owner's decisions. Reasons: tenants are read on every request and change rarely, so a network hop buys nothing; integrations are driven by domain events that already live in `engagement`, so adapters sit next to the events they react to.

Modules are separated by Nx tags and import boundaries, so promoting a module to a service later is a mechanical move, not a rewrite.

### Consequences

Good:
- The ledger has a single writer, so its invariants are testable in one place.
- Identity compromise surface is limited to one service.
- A casino outage affects `engagement` only.

Bad (the cost we accept):
- No cross-service transaction. A redemption spans two databases and needs a saga with compensation (ADR 0006).
- Every cross-service fact travels by event, with outbox and inbox on both sides (ADR 0003). That is more code and more failure modes than function calls.
- Local setup needs more containers; clean-clone start time rises.
- Debugging needs correlation ids and traces end to end.
- Contract drift between services needs shared, versioned schemas (`packages/contracts`) and contract tests.

## Pros and cons of the options

- Option 1: cheapest now, but money and identity would share a process and a database from day one; splitting them later means data migration under load.
- Option 3: maximum isolation, but seven deployables for a two-day build and for a team of three; most seams would be chosen before the domain is understood.

## Built vs designed

- Built in the submission: the services above, each with its own database and container.
- Designed only: extracting `tenants` or `integrations` into services; independent scaling profiles per worker.
