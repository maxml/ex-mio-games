---
id: MIO-103
title: Player funnel instrumentation
epic: EPIC-10
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-101, MIO-066]
size: S
---

## Goal

Show operators (and ourselves) that the wheel and store change player behaviour, which is what we sell.

## Scope

`player.deposit_completed → game.spin_granted → game.spin_completed → coins.earned → reward.redeemed →
reward.issued`, plus `widget.opened` from the frontend (consented).

## Acceptance criteria

- The demo scenario (MIO-005) produces each event once per step, per casino.
- Events carry the pseudonymous `actor_id`, never the casino's external player id.
