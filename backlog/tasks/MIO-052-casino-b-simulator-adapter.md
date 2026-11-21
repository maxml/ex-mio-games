---
id: MIO-052
title: "Casino B: simulator and adapter with a different schema and reward API"
epic: EPIC-06
priority: P0
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-050]
size: M
---

## Goal

Prove the integration layer: a second platform with a really different shape uses the same internal logic.

## Scope

- `casino-b-sim`: different event schema (for example snake_case, `{type: "payment.completed", data:
  {txn_id, customer_ref, amount_cents, ccy}, sent_at}` with a signature in the body envelope) and a
  different reward API (asynchronous: `POST /v2/rewards` returns `202` with a ticket; status by polling
  `GET /v2/rewards/{ticket}` or a callback).
- Adapter B in the integrations module.

## Acceptance criteria

- The same demo scenario (MIO-005) passes for Casino B with no change to rules, wheel, store or ledger code.
- The change set that adds Casino B touches only the integrations module, its simulator, compose and seed
  (checked in review against the diff).
- Adapter B passes the shared adapter contract suite (MIO-057).
