---
id: MIO-050
title: Canonical event model and adapter interface
epic: EPIC-06
priority: P0
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-015]
size: M
---

## Goal

Gamification logic never sees a casino-specific shape.

## Scope

- Canonical inbound event: `{tenant_id, source, external_event_id, type: "deposit.succeeded",
  external_player_id, amount_minor, currency, occurred_at}`.
- `CasinoAdapter` interface: `parseEvent(raw, headers) → CanonicalEvent | Rejection`,
  `issueReward(request, idempotencyKey) → IssueResult`, `getRewardStatus(ref) → Status`,
  `verifySignature(raw, headers, secret)`.
- Adapter registry keyed by the tenant's configured casino type.

## Acceptance criteria

- Rules engine, wheel and store code import only canonical types (lint boundary).
- Money amounts are integers in minor units; a float amount in a casino payload is rejected, not rounded.
- Adding an adapter needs no change outside the integrations module (proven by MIO-052).
