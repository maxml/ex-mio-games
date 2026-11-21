# 0008. Casino integration adapters and a canonical model

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: high

## Context and problem statement

Each casino platform has its own event schema, its own reward API and its own authentication. The brief needs two simulated platforms with different shapes that feed the same gamification logic, and the product must support ten operators without ten codebases.

## Decision drivers

- Rules, wheel, store and ledger must know nothing about any casino's format.
- Adding an operator should be configuration plus, at most, one small adapter.
- Incoming events are untrusted; outgoing reward calls can fail ambiguously.

## Considered options

1. Branch on platform inside the business logic.
2. A per-platform adapter that translates to and from a canonical model, inside an `integrations` module of `engagement`.
3. A generic mapping engine driven only by configuration.

## Decision outcome

Option 2.

- **Inbound.** An adapter validates the casino's own signature scheme (casino A: HMAC over `timestamp.body` in headers with a 300 s window; casino B: signature inside the body), with a secret per tenant held by identity and rotatable (the adapter in engagement reads it over an allow-listed internal route), validates the payload with a zod schema, and maps it to a canonical event `{event_id, tenant_id, platform, external_player_id, kind, amount_minor, currency, occurred_at}`.
- **Ingestion.** Deduplication is `UNIQUE (tenant, source, external_event_id)`. Invalid and unsigned events are rejected with a code and logged (no counter metric, and rejected bodies are not stored); they never reach the rules engine. The stored event keeps a per-tenant HMAC of the casino's player id, not the raw id.
- **Outbound.** One casino reward port in `packages/contracts/src/casino-adapter.ts` with `issueReward` and `getRewardStatus(ourKey)`; results are `issued`, `pending`, `rejected` or `unknown` (a timeout is `unknown`, never a failure), and a lookup returns `issued`, `pending`, `rejected`, `not_found` or `unknown`. Each adapter declares native lookup by our key or guaranteed idempotent replay; an adapter that offers neither cannot register.
- **Contract suite.** One shared suite runs against every adapter (duplicates, bad signature, replay, timeout, lost reply).
- **Operators** are tenants with per-tenant configuration (credentials with an `environment` of sandbox or production, mapping). Rate limits are Next.
- The module stays inside `engagement` (owner decision) behind an Nx boundary, so rules and wheel import only the canonical types.
- New features (missions, PvP) consume canonical events and never call an adapter directly.

### Consequences

Good: two schemas, one logic; a new casino is a new adapter and a contract-suite run.

Bad: a canonical model loses platform-specific detail unless extended with care; adapters are code, so onboarding is not purely self-service; the model needs versioning once it has consumers.

## Pros and cons of the options

- Option 1: simplest first, impossible to maintain by the third operator.
- Option 3: attractive for onboarding, but real platforms differ in authentication and error semantics that configuration cannot express.

## Built vs designed

- Built: adapters for the two simulated casinos, canonical model, ingestion with dedupe, contract suite.
- Next: self-service operator onboarding, a third adapter, canonical model v2.
