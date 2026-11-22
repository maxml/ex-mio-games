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
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

Provider webhooks are the only way a payment changes our state, and they cannot be forged or replayed.

## Scope

- Signature verified on the raw body before parsing, with a constant-time compare that never throws on
  a length mismatch; bad, malformed or missing signature returns 400 and changes nothing.
- The webhook secret is required configuration: with the provider enabled and no secret, the service
  refuses to start (it never falls back to "no verification").
- `UNIQUE (provider, provider_event_id)` in a durable inbox table; the inbox row, the state change and the
  outbox message are one transaction.
- Acknowledge rule: a 2xx is returned only after that transaction committed. Any processing error returns
  non-2xx so the provider retries; no error is swallowed with a 200. If processing is deferred, the 2xx
  is allowed only after the raw event is durably stored in the inbox with status `pending`, and a worker
  processes it with retries.
- No configuration flag can skip verification.

## Acceptance criteria

- Bad signature: 400, no row written. Signature of the wrong length or not hex: 400, no exception logged
  as a crash.
- Provider enabled with the secret unset: start-up fails with a clear error (config test).
- The same event delivered twice: one state change. The same event delivered concurrently to two
  service instances: one state change (two processes against one database).
- The same event delivered after a service restart: one state change (no process-memory dedupe).
- An exception in the handler: 5xx returned, transaction rolled back, the retried delivery succeeds.
- Database unavailable during delivery: non-2xx, nothing half-written; the retried delivery succeeds.
- A search test fails if any environment variable that disables verification is read anywhere; a
  production-mode boot test with such a variable set still verifies signatures.
- Reader test: the inbox record written by a webhook is read back by the inbox status API (processed,
  superseded or failed, with the provider event id), described correctly.
