---
id: MIO-130
title: "Player widget: wheel, balance, store, reward status, history"
epic: EPIC-13
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-123, MIO-063, MIO-066, MIO-112]
size: L
---

## Goal

What the player sees inside the casino site; the visible half of the sellable demo.

## Scope

- Wheel with the segments of the active table (labels only); spin button enabled only with an available credit.
- The animation lands on the segment returned by the server; the client never picks a result.
- Coin balance (live), Bonus Store, redeem with confirmation, reward status (live), coin history.
- Built only from `packages/ui` components.

## Acceptance criteria

- Playwright end-to-end: deposit from the simulator, spin appears, spin, balance increases, redeem,
  status reaches `ISSUED`, all without page reloads.
- Double-clicking "spin" or "redeem" sends one request (and the server would dedupe anyway).
- The widget works at 360 px width.
