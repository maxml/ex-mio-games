---
id: MIO-112
title: "Push events: spin granted, balance changed, redemption status changed"
epic: EPIC-11
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-110, MIO-061, MIO-083, MIO-067]
size: S
---

## Goal

The player sees the result of a deposit, a spin and a redemption without reloading.

## Scope

The websocket server consumes `SpinGranted`, `BalanceChanged`, `RedemptionStatusChanged` from RabbitMQ and pushes to
the owner's channel; operator channel gets integration log events (MIO-097).

## Acceptance criteria

- In the demo scenario, each of the three events arrives at the player's socket within one second of the
  domain event (end-to-end test).
- An event for player X never arrives on player Y's socket.
