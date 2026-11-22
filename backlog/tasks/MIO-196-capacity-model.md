---
id: MIO-196
title: Capacity model and scale-out triggers
epic: EPIC-18
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-160, MIO-193, MIO-194]
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

Answer "how big does this need to be for N operators, and when do we scale out" with a model calibrated by
a measurement, not a guess.

## Scope

- `docs/performance/capacity.md` and a small script `tools/capacity/model.ts` that takes tenants, players
  per tenant, deposit events per player per day and peak factor, and returns events per second at peak.
- From events per second, the model derives:
  - **Database connections** per service: pool size from the fixed pool bound of MIO-032, concurrent
    transactions from the measured transaction time, headroom for the outbox relays and workers.
  - **RabbitMQ throughput:** messages per second from the number of messages one deposit, one spin and
    one redemption produce (counted in the harness), plus the outbox and DLQ overhead, and queue depth
    under a burst.
  - **Postgres sizing:** rows per day per table (events, inbox, outbox, ledger entries, audit), storage
    per month, WAL volume, and the working set against memory.
  - Redis memory for balance cache and idempotency keys.
- A scale-out trigger table: for each resource a metric from MIO-160, a threshold, a duration and the
  action (for example pool utilisation above 70 percent for 15 minutes, queue depth growing for 10
  minutes, p95 above 80 percent of the SLO for a day, storage growth projecting full in 30 days). Each
  trigger names the alert that will fire it (MIO-164).
- The model is calibrated against the baseline report of MIO-194; the doc states the calibration run.
- Link to Part E question 1: the scale-out milestone of MIO-187 takes its entry and exit numbers from
  this model, and the document says which operator count each milestone supports.

## Acceptance criteria

- Given the inputs of the baseline run, the model reproduces the measured message rate and connection
  count within 25 percent (a test with the committed baseline as the fixture).
- For 10 operators the document states events per second at peak, connections per service, messages per
  second, storage per month and the smallest Postgres and RabbitMQ size that fits, with the assumptions.
- Every trigger names a metric that exists in the telemetry of MIO-160, a threshold, a duration and an
  action; a script fails on a trigger without a registered metric.
- Changing one input (for example the number of tenants) changes the outputs, and the unit tests cover
  tenants, players and events per second as separate inputs.
- `docs/scaling/README.md` section 1 links to the document.

## Notes

Forward pointers: MIO-187 uses these numbers for the scale-out milestone, and MIO-182 collects them in
the Part E answers. The model is a planning tool, not a promise; each release re-checks it against the
nightly run of MIO-195.
