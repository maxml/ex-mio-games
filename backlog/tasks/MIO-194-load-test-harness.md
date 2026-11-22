---
id: MIO-194
title: Load-test harness with k6 against the compose stack, and the first committed report
epic: EPIC-18
priority: P1
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-002, MIO-005, MIO-051, MIO-052, MIO-053, MIO-063, MIO-066, MIO-160, MIO-193]
size: M
estimate_hours_base: 24
estimate_hours: 29
---

## Goal

Measure the four critical paths on the running stack, repeatably, with both casino simulators, and commit
the result as a report that anyone can regenerate.

## Scope

- `tests/perf/` with k6 scenarios, run as a container next to the compose stack. Why k6: scenarios are
  TypeScript-friendly JavaScript, thresholds are code and set the exit code, arrival-rate executors model
  a request rate and not a user count, results export as JSON, and it needs no account. Considered:
  Artillery (weaker thresholds), Gatling (JVM toolchain), autocannon (no scenarios).
- Casino traffic comes from `casino-a-sim` and `casino-b-sim` (webhooks and the reward API), driven
  through their existing endpoints and the fault plan of MIO-053; no scenario talks to a database.
- Scenarios:
  1. **Deposit burst:** a burst of deposit webhooks for one tenant at its burst rate, then a quiet period;
     measures webhook acknowledgement, time to `SpinGranted`, and queue drain time.
  2. **Spin storm on one player:** many parallel spins for one player with one and with several credits;
     measures spin latency and asserts exactly one spin per credit (concurrency).
  3. **Redemptions with a slow casino reward API:** the simulator `slow` fault at 5 s; measures request
     acknowledgement, time to final status, and that workers are not starved (other redemptions still
     finish).
  4. **Multi-tenant noisy neighbour:** one tenant at burst rate while the others run at steady rate;
     measures the others' p95 against the rule of MIO-193.
- `pnpm perf:run <scenario>` and `pnpm perf:report`, which writes `docs/performance/reports/<date>-<sha>.md`
  from the k6 JSON (never typed by hand): environment (CPU, memory, versions, commit), per scenario the
  p50, p95 and p99 latency, throughput, errors, and pass or fail against MIO-193.
- Thresholds are read from `tests/perf/thresholds.json`, generated from `docs/performance/slo.md`.

## Acceptance criteria

- On a clean machine with only Docker, `docker compose up -d --wait` then `pnpm perf:run all` exits 0 or
  non-zero by the thresholds, and a report file is written.
- Each of the four scenarios runs for Casino A and for Casino B.
- A committed report exists with the four scenarios, the environment block and the commit it was run on;
  regenerating it from the committed k6 JSON gives the same file.
- The spin storm asserts: with one credit and 50 parallel requests exactly one spin and a ledger credit of at
  most one; the numbers come from the public API, not from a database read.
- The slow-casino scenario shows the final status for every redemption and no redemption in `UNKNOWN` after
  its timeout window.
- The noisy-neighbour scenario fails (a test run once and recorded) when tenant isolation of capacity is
  removed, for example when the per-tenant limit of MIO-152 is disabled or a shared pool is exhausted.
- Every threshold in `thresholds.json` traces to a row of `docs/performance/slo.md` (a check fails on a
  threshold with no SLO row).

## Notes

The 1,000-client websocket reconnect test stays in MIO-111 and is not duplicated here; the report links
to it. The per-tenant rate limit (MIO-152) is P2, so the noisy-neighbour scenario records the result with
and without it.
