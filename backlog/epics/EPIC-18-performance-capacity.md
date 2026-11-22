---
id: EPIC-18
title: Performance, capacity and load testing
priority: P1
status: todo
---

# EPIC-18 Performance, capacity and load testing

## Goal

We know how fast and how large the money paths are, we find out when a change makes them slower, and we
know when to scale out. Before this epic nothing was measured and there were no service level objectives.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-193 | SLOs and a performance budget for the four critical paths | P1 |
| MIO-194 | Load-test harness with k6 and the first committed report | P1 |
| MIO-195 | Performance regression gate in CI | P1 |
| MIO-196 | Capacity model and scale-out triggers | P1 |
| MIO-197 | Soak test | P2 |

## Boundaries

The first sellable slice does not change: none of these tasks is a dependency of MIO-005 or MIO-121, so
all are P1 or P2. The websocket reconnect test of 1,000 clients stays in MIO-111. Telemetry (MIO-160)
supplies the metrics; this epic adds targets and measurement on top of it.
