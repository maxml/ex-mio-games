---
id: MIO-085
title: Ledger history API for players and operators
epic: EPIC-08
priority: P1
money_impact: enabler
risk_class: ownership
status: todo
depends_on: [MIO-082]
size: S
---

## Goal

Players see where their coins came from and went; operators can answer support questions.

## Scope

- `GET /v1/me/coins/history` (cursor paginated) and an operator equivalent per player.
- Each row: time, amount, direction, reason, link to the spin or redemption.

## Acceptance criteria

- A player sees only their own entries; another player's history returns 404.
- The sum of the history equals the current balance in a seeded test.
