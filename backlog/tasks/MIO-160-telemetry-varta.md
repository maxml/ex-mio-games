---
id: MIO-160
title: "Telemetry under the Varta contract: logs, traces, metrics, correlation ids"
epic: EPIC-15
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-001]
size: M
---

## Goal

Assignment Part A: observability. We can follow one deposit from webhook to issued reward.

## Scope

- Structured JSON logs with service, env, version, `trace_id`, `correlation_id`, `tenant_id`; secrets and
  personal data redacted.
- OpenTelemetry traces across HTTP and RabbitMQ (context carried in message headers).
- Metrics: events accepted and rejected by reason, spins, redemptions by final status, issuance latency,
  DLQ depth, reconciliation mismatches. `tenant_id` is never a metric label.
- Opt-in export to Varta; with Varta absent, everything still works locally.

## Acceptance criteria

- One trace connects the webhook request, the `DepositConfirmed` consumer, the spin, the coin credit and
  the redemption (end-to-end test asserts span parents).
- A log-redaction test: a request containing an email and a token produces logs without either.
