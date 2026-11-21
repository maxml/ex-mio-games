---
id: MIO-094
title: "Billing webhooks: fail-closed and idempotent"
epic: EPIC-09
priority: P0
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-090]
size: M
---

## Goal

Provider webhooks are the only way a payment changes our state, and they cannot be forged or replayed.

## Scope

- Signature verified on the raw body before parsing; bad or missing signature returns 400 and changes nothing.
- `UNIQUE (provider, provider_event_id)`; the record, the state change and the outbox message are one transaction.
- Any processing error returns non-2xx so the provider retries; no error is swallowed with a 200.
- No configuration flag can skip verification.

## Acceptance criteria

- Bad signature: 400, no row written.
- The same event delivered twice: one state change.
- An exception in the handler: 5xx returned, transaction rolled back, the retried delivery succeeds.
- A search test fails if any environment variable that disables verification is read anywhere.
