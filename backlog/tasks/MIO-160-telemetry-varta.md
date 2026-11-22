---
id: MIO-160
title: 'Telemetry under the Varta contract: logs, traces, metrics, correlation ids'
epic: EPIC-15
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-001]
size: M
estimate_hours_base: 20
estimate_hours: 24
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
- A log-redaction test at the logger and telemetry boundary: requests and events containing an email, an
  access token, a launch token, a webhook signature, an integration secret and a casino external player
  id are processed with the log level at `debug`; the log sink, the trace exporter and the error reporter
  are read back and contain none of them (known tenancy defect 10).
- Redaction is applied by the logger itself (a deny-list of field names plus value patterns), not by
  callers; a mutation that removes it turns the test red.

## Notes

The SLO table in MIO-193 names the latency histograms and queue-depth gauges it needs for the four
critical paths (ingest to spin credit, spin, redemption to issuance, balance read). They are added here as
metrics; MIO-193 checks that every metric it names exists. Forward pointer only: this task does not
depend on MIO-193.
