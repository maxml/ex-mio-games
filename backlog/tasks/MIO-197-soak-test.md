---
id: MIO-197
title: Soak test of several hours for queue growth, leaked connections and the DLQ
epic: EPIC-18
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-056, MIO-084, MIO-160, MIO-162, MIO-194]
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

Find the defects that only appear after hours: tables and queues that grow without bound, connections that
leak, messages that pile up in the DLQ.

## Scope

- A soak mode of the harness (MIO-194): a mixed workload of all four scenarios at about 30 percent of the
  budget rate for 4 hours by default (configurable to 12), with one planned broker restart and one
  simulator `error500` period in the middle.
- Sampling every minute of: unsent outbox rows and oldest unsent age, inbox table size against its
  retention, DLQ depth, database connections per service (active and idle), process memory per service,
  Redis memory and AOF size, queue depths.
- A committed report `docs/performance/reports/<date>-soak.md` with the series and the verdicts.

## Acceptance criteria

- After the last load minute and a drain period, unsent outbox rows are zero and the oldest unsent age
  returns to the baseline; no outbox table grows in a straight line during steady load.
- The inbox purge keeps the inbox size within its retention bound (steady state, not growth).
- Database connections per service at the end equal the start within 10 percent, and no connection is
  idle in transaction for more than 30 seconds at any sample.
- Process memory per service grows by less than 10 percent per hour after a 30-minute warm-up.
- DLQ depth is zero at the end; any message that reached the DLQ during the planned fault is replayed with
  the `replay` command and ends processed once.
- The reconciliation job (MIO-084) reports no mismatch at the end of the run.
- A deliberately leaked connection (a handler that does not release it, applied as a mutation) turns the
  connection check red.

## Notes

The soak does not run in CI per merge. It runs before a release and is started by hand or by a scheduled
job; the report is committed with the release.
