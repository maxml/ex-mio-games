---
id: MIO-050
title: Canonical event model and adapter interface, with the recovery contract
epic: EPIC-06
priority: P0
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-015]
size: M
estimate_hours_base: 24
estimate_hours: 29
---

## Goal

Gamification logic never sees a casino-specific shape, and every adapter can answer "did you issue this
reward?" even when the casino's reply (and the casino's own reference) was lost.

## Scope

- Canonical inbound event: `{tenant_id, source, external_event_id, type: "deposit.succeeded",
external_player_id, amount_minor, currency, occurred_at}`.
- `CasinoAdapter` interface: `parseEvent(raw, headers) → CanonicalEvent | Rejection`,
  `issueReward(request, idempotencyKey) → IssueResult`, `getRewardStatus(idempotencyKey) → Status`,
  `verifySignature(raw, headers, secret)`.
- **Recovery contract (lost reference).** Status is always looked up by **our** idempotency key
  (`redeem:{redemption_id}`), never only by the casino's reference, because the reference may be in the
  reply we never received. An adapter must satisfy one of these, declared in its registry entry:
  1. the casino API can look up a reward by our key (native lookup); or
  2. re-sending `issueReward` with the same key is guaranteed by the casino to return the original
     result and reference without issuing again (idempotent replay), and the adapter uses that as its
     status lookup.
     An adapter that can do neither is not registrable. `Status` is `issued(reference)`, `rejected(code)`,
     `pending`, or `not_found`.
- The reward mapping (reward type and parameters in canonical form) is frozen on the redemption at order
  time and passed to `issueReward` unchanged on every attempt.
- Adapter registry keyed by the tenant's configured casino type.

## Acceptance criteria

- Rules engine, wheel and store code import only canonical types (lint boundary).
- Money amounts are integers in minor units; a float amount in a casino payload is rejected, not rounded.
- **Effect done, reply with the external id lost:** with an in-memory reference adapter for each recovery
  mode, a test transport issues the reward and drops the reply; `getRewardStatus(ourKey)` returns
  `issued` with the casino's reference; no second reward.
- Registering an adapter without a declared recovery mode fails the registry test.

## Notes

The same case is repeated for every real adapter by the shared contract suite (MIO-057). That adding an
adapter needs no change outside the integrations module is shown later by MIO-052.
