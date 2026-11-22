---
id: MIO-053
title: Simulator fault injection
epic: EPIC-06
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-051, MIO-052]
size: S
---

## Goal

Reliability cases can be shown on demand, in tests and live.

## Scope

Both simulators accept a fault plan (`POST /__faults`): `timeout` (hang past our client timeout, but still
issue the reward), `dropReply` (issue the reward, then close the connection before replying, so the caller never sees the
casino's reference), `error500`, `reject` (final business rejection), `slow`, `duplicateDelivery` (send the
same webhook N times), `outOfOrder`. Faults can target the next N calls or a specific player.

## Acceptance criteria

- Each fault type has a test proving the simulator behaves as configured.
- Fault plans reset between test cases (no leakage between tests).
- The fault endpoint is not exposed outside the compose network.
- `timeout` really issues the reward on the simulator side and records it, so a test can tell an
  ambiguous result (issued, but we did not hear back) from a lost request (not issued).

## Notes

The live demonstration of these faults (`pnpm demo --faults`) is MIO-145.
