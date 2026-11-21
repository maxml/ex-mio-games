---
id: MIO-107
title: "Privacy: PII rules, consent, delete-by-actor runbook"
epic: EPIC-10
priority: P1
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-101]
size: S
---

## Goal

Analytics without collecting personal data we do not need, and a way to honour deletion requests.

## Scope

- Rules in `docs/analytics/privacy.md`: pseudonymous ids only; no email, IP, card or casino player id in events.
- Consent stored per actor (version and timestamp); the emitter reads it.
- Runbook: delete or anonymise all data for one `(tenant_id, user_id)` across services and analytics.

## Acceptance criteria

- A test feeds events with forbidden fields and asserts they are rejected before reaching any sink.
- The delete runbook is executed in a test against seeded data and leaves no rows referencing the actor
  (ledger entries are kept but re-pointed to an anonymous account, as financial records must stay).
