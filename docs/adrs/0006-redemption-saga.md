# 0006. Redemption as a saga with compensation

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: medium-high

## Context and problem statement

Redeeming coins for a Bonus Store reward touches three things that cannot share a transaction: stock and per-player limits (in `engagement`), coins (in `payments`), and the reward issued at the casino (an external API). The casino call can time out, fail, or succeed with a lost reply. The brief requires no duplicate rewards and no negative balances.

## Decision drivers

- Duplicate redemption requests must produce one redemption.
- A timeout is not a failure; the effect may have happened.
- Coins must not be released while the casino may still have issued the reward.
- Every step must be retryable after a crash at any durable boundary.

## Considered options

1. A distributed transaction (two-phase commit).
2. Orchestrated saga in `engagement` with per-phase idempotency keys and explicit compensations.
3. Choreographed saga with events only.

## Decision outcome

Option 2.

- **Two reserves, two databases, one order.** In the `REQUESTED` transaction `engagement` reserves stock and the per-player limit and freezes the price and reward mapping. Then `payments` places a coin **hold** (`hold_id = redemption_id`).
- **Per-phase keys.** `hold:<id>`, `capture:<id>`, `release:<id>`, `refund:<id>`. The client's `Idempotency-Key` is scoped to `(tenant, principal, operation, key)` with a canonical request hash; a repeat returns the stored result, a changed body is rejected.
- **States.** `REQUESTED -> HELD -> ISSUING -> ISSUED -> COMPLETED`, with `REJECTED_FUNDS`, `FAILED` (final casino refusal), `UNKNOWN` (ambiguous result) and `NEEDS_REVIEW`. The full transition table is in the lifecycle diagram.
- **Release vs refund.** Release returns held coins when the casino finally refuses. Refund reverses an already captured amount, and only if the casino revokes the reward.
- **Lost-ticket recovery.** Every adapter must declare either a native lookup by our key (`getRewardStatus(ourKey)`) or guaranteed idempotent replay. On timeout the state becomes `UNKNOWN`; a worker queries the casino by our key before deciding. Success after a "timeout" moves to `ISSUED`, never to a second issue.
- **No automatic release on unknown.** A sweeper retries with backoff up to a maximum age, then moves to `NEEDS_REVIEW` for a human.
- **Compensation order** is the reverse of the reserves: release the hold, then return stock and limit.
- Late success and late rejection after a terminal state are recorded and reconciled, not applied blindly.

### Consequences

Good: no distributed lock, every transition is retry-safe, and ambiguity has a named state rather than a guess.

Bad: more states and more tests; a redemption can be visibly pending for a while; `NEEDS_REVIEW` needs a human and a runbook.

## Pros and cons of the options

- Option 1: not available across a separate database, a broker and an external API.
- Option 3: no single place that knows the state; harder to reason about timeouts and to expose status through an API.

## Built vs designed

- Built: the orchestrator, states, per-phase keys, recovery by our key for both simulated casinos, fault injection (`timeout`, `dropReply`, `fail`).
- Designed only: the human review workflow behind `NEEDS_REVIEW`; automatic late-rejection refunds beyond the recorded case.
