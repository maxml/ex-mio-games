# 0006. Redemption as a saga with compensation

Diagram: section [2](../../docs/architecture/README.md#2-sequence-the-8-step-workflow), [3](../../docs/architecture/README.md#3-workflow-redemption-saga-with-compensations), [5](../../docs/architecture/README.md#5-lifecycle-redemption-states) of the diagram hub (why each diagram exists: [table](../../docs/architecture/README.md#why-each-diagram-exists)).

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

- **Two reserves, two databases, one order.** In the `REQUESTED` transaction `engagement` reserves stock and the per-player limit and freezes the price and reward mapping. Then `payments` places a coin **reserve** (`reserve_id = redemption_id`) through a synchronous internal call, because the saga needs an immediate answer; an unaffordable order is a 409 `insufficient_funds` to the player, not an error found later.
- **Per-phase keys.** `hold:<id>`, `capture:<id>`, `release:<id>`, `refund:<id>`. The client's `Idempotency-Key` is scoped to `(tenant, principal, operation, key)` with a canonical request hash; a repeat returns the stored result, a changed body is rejected.
- **States.** `REQUESTED -> RESERVED -> ISSUING -> ISSUED -> COMPLETED`, with `REJECTED_FUNDS`, `REJECTED` (final casino refusal) then `RELEASED`, `REFUNDED`, `UNKNOWN` (ambiguous result) and `NEEDS_REVIEW`. The full transition table is in `apps/engagement/src/model/redemption-state.ts` and in the lifecycle diagram. `ISSUING` is committed before the adapter is called.
- **Release vs refund.** Release returns reserved coins when the casino finally refuses. Refund reverses an already captured amount, and only if the casino revokes the reward.
- **Lost-ticket recovery.** Every adapter must declare either a native lookup by our key (`getRewardStatus(ourKey)`) or guaranteed idempotent replay. On timeout the state becomes `UNKNOWN`; a worker queries the casino by our key before deciding. Success after a "timeout" moves to `ISSUED`, never to a second issue.
- **No automatic release on unknown.** A sweeper retries with backoff up to 8 attempts or 24 hours, then moves to `NEEDS_REVIEW` for a human.
- **Compensation order** is the reverse of the reserves: release the coins, then return stock and limit, exactly once whatever the path.
- Late success and late rejection after a terminal state move the row to `NEEDS_REVIEW` and never move coins by themselves.
- **Operator resolution moves coins only on evidence.** `issued` captures only after a status lookup by our key returns `issued`; `not_issued` after coins were released needs a `not_found` lookup past the issue deadline. A replay from review to `UNKNOWN` is allowed only for a review entered from `UNKNOWN`.

Status note (2026-11-23): the idempotency text above differs from the code. Per-phase keys are `hold:`, `capture:`, `release:`, `refund:`, `redeem:` followed by `<tenant>:<sbx|prd>:<id>`. The client's `Idempotency-Key` names one order per tenant, player and environment (an advisory lock and a unique row). There is no canonical request hash: the same key with another item is 422 `idempotency_key_reused`. The hash lives in `packages/idempotency`, which only payments uses. Capture, release and refund are synchronous calls to payments, like the reserve.

### Consequences

Good: no distributed lock, every transition is retry-safe, and ambiguity has a named state rather than a guess.

Bad: more states and more tests; a redemption can be visibly pending for a while; `NEEDS_REVIEW` needs a human and a runbook.

## Pros and cons of the options

- Option 1: not available across a separate database, a broker and an external API.
- Option 3: no single place that knows the state; harder to reason about timeouts and to expose status through an API.

## Built vs designed

- Built: the orchestrator, states, per-phase keys, recovery by our key for both simulated casinos, fault injection (`timeout`, `dropReply`, `fail`), the operator review route (`POST /v1/operator/redemptions/:id/resolve`) with evidence rules.
- Next: a review queue UI and runbook at volume; automatic late-rejection refunds beyond the recorded case.
