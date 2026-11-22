---
id: MIO-193
title: SLOs and a performance budget for the four critical paths
epic: EPIC-18
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-005, MIO-160]
size: M
estimate_hours_base: 12
estimate_hours: 15
---

## Goal

State, in numbers, how fast and how much each money path must be, per tenant and in aggregate, so that
the load tests (MIO-194), the CI gate (MIO-195), the capacity model (MIO-196) and the alerts have one
source of truth. Today the backlog has one load-test criterion (MIO-111), one latency metric (MIO-160)
and one example target (MIO-183).

## Scope

`docs/performance/slo.md` with one table row per critical path. Columns: path, user-visible meaning,
p95 and p99 latency, sustained and burst throughput per tenant, sustained throughput in aggregate, the
metric that measures it (from MIO-160), the error budget, and what happens on a breach. The first values
are proposals for the first pilot and are replaced by the measured baseline of MIO-194:

| Path                                                                  | p95 / p99       | Per tenant (sustained / burst for 60 s) | Aggregate            |
| --------------------------------------------------------------------- | --------------- | --------------------------------------- | -------------------- |
| Deposit ingest to spin credit: webhook acknowledged                   | 150 ms / 400 ms | 10 / 50 events per second               | 50 events per second |
| Deposit ingest to spin credit: `SpinGranted` visible to the player    | 2 s / 5 s       | queue drains within 120 s after a burst | same                 |
| Spin (`POST /v1/spins`)                                               | 200 ms / 500 ms | 5 per player, 20 per tenant             | 100 per second       |
| Redemption to issuance: request acknowledged                          | 300 ms / 800 ms | 5 / 20 per second                       | 20 per second        |
| Redemption to issuance: final status with a casino reply under 500 ms | 2 s / 6 s       | same                                    | same                 |
| Balance read                                                          | 50 ms / 150 ms  | 50 / 200 per second                     | 500 per second       |

- A budget split for the two longest paths: how much of the p95 each hop may use (webhook, inbox and
  outbox write, broker, consumer, ledger transaction, adapter call).
- A rule for the noisy neighbour: one tenant at its burst rate must not move another tenant's p95 by
  more than 20 percent.
- How the budget feeds the 90-day plan: the table is the source of the measurable outcomes in MIO-183
  (the p95 issuance latency and the SLO milestone of days 31 to 60) and of the alert thresholds in
  MIO-164; a row changes only through a change to this file.

## Acceptance criteria

- Every one of the four paths has a p95 and a p99 latency target, a throughput target per tenant and a
  throughput target in aggregate; a script reads the table and fails on an empty cell.
- Every row names a metric, and a check fails if a named metric is not registered in the telemetry of
  MIO-160 (no SLO without a measurement).
- The two longest paths have a per-hop budget whose parts sum to no more than their p95.
- `docs/scaling/90-days.md` and MIO-183 quote their latency figures from this table (a check compares the
  numbers).
- Each target names how it will be verified: a scenario name or an alert name (the scenarios and alerts
  themselves are built in MIO-194 and MIO-164; forward pointers, see Notes).

## Notes

Reconnect behaviour of the websocket stays in MIO-111 (its 1,000-client test); this task does not cover
the socket. Targets are proposals, not measurements; the first measured baseline (MIO-194) either
confirms them or changes this file in the same merge.
