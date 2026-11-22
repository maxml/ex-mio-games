---
id: MIO-145
title: 'Part C: retries and eventual recovery'
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: concurrency
status: todo
depends_on: [MIO-056, MIO-068, MIO-053, MIO-084, MIO-005]
size: M
---

## Goal

Prove that the system converges to the right state after crashes and outages, and show it live with
`pnpm demo --faults`.

## Acceptance criteria

- Payments down during a spin: the coin credit lands once after payments comes back.
- RabbitMQ restarted mid-scenario: the demo scenario still completes; no duplicate effects.
- Engagement worker killed while a redemption is `ISSUING`: after restart the redemption reaches a final state.
- Simulator `error500` for longer than the attempt cap: message in DLQ, alert raised; after the fault is
  cleared, `replay` completes the redemption once.
- All of the above run as one chaos test suite in CI (`pnpm test:chaos`) against compose.
- **Ambiguous external result, live:** `pnpm demo --faults` runs the demo with (a) a casino `timeout`
  where the reward was in fact issued, which the output shows going `ISSUING → UNKNOWN → ISSUED →
COMPLETED` with exactly one reward in the simulator, and (b) a final `reject`, which ends `RELEASED`
  with the coins back. The run ends by printing the ledger conservation report (MIO-084) and fails if
  the identity does not hold.
