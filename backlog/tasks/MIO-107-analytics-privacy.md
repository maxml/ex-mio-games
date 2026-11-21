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
- **Anonymisation model (decided before the ledger and audit schemas, MIO-013):** personal data lives
  only in identity (profile, email, `player_links` with the casino's external player id). Every other
  service, the ledger, the audit log and analytics refer to a person only by opaque ids (`user_id`,
  `account_id`, `actor_id`) that carry no personal data. Deleting a person removes the identity profile
  and the `player_links` row and marks the user `erased`; ledger, audit and analytics rows are never
  changed, so the append-only rules hold and the financial history stays complete but no longer points
  to a person.
- Runbook: erase one `(tenant_id, user_id)` as above, plus any personal fields in caches and logs within
  their retention.

## Acceptance criteria

- A test feeds events with forbidden fields and asserts they are rejected before reaching any sink.
- A schema test fails if any table outside identity has a column for email, name, IP or external player id.
- The erase runbook is executed in a test against seeded data: the identity profile and link are gone;
  ledger entries, audit rows and analytics events are unchanged and still balance; no remaining row in
  any service can be joined back to the person's email or external player id.
