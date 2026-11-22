---
id: MIO-052
title: "Casino B: simulator and adapter with a different schema and reward API"
epic: EPIC-06
priority: P1
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-050, MIO-057, MIO-005]
size: M
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

Prove the integration layer: a second platform with a really different shape uses the same internal logic.
This is a required assignment deliverable; it is not on the first sellable slice, which needs one casino.

## Scope

- `casino-b-sim`: different event schema (for example snake_case, `{type: "payment.completed", data:
  {txn_id, customer_ref, amount_cents, ccy}, sent_at}` with a signature in the body envelope) and a
  different reward API (asynchronous: `POST /v2/rewards` returns `202` with a ticket; status by polling
  `GET /v2/rewards/{ticket}` or a callback). Recovery mode: idempotent replay (re-sending
  `POST /v2/rewards` with the same key returns the original ticket without issuing again), because
  Casino B has no lookup by our key.
- Adapter B in the integrations module.
- Casino B added to the demo scenario (MIO-005) as a second parameter of the same scenario function.

## Acceptance criteria

- **Two-operator parity:** the demo runs for two operator tenants, one on Casino A and one on Casino B,
  with the identical assertion list (the test asserts both runs used the same list object and the same
  number of assertions), and both pass with no change to rules, wheel, store or ledger code.
- After both runs, each operator sees only its own players, redemptions and funnel events.
- The change set that adds Casino B touches only the integrations module, its simulator, compose and the
  demo parameter list (checked in review against the diff).
- Adapter B passes the shared adapter contract suite (MIO-057).
