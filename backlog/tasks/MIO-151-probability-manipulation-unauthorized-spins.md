---
id: MIO-151
title: 'Part C: reward probability manipulation and unauthorized spins'
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-063, MIO-069]
size: S
---

## Goal

Prove the claims in `docs/fairness.md`.

## Acceptance criteria

- Spin request with extra fields (`weights`, `segment`, `seed`, `table_version`): 422.
- Spin without an available credit: 409. Spin with another player's credit id: 404.
- Spin with an operator or platform token: 403 (only the player can spin).
- Player API responses never contain weights or seeds (schema test on every player endpoint).
- Granting credits is impossible through any public endpoint (route table test: only the deposit consumer
  and an audited operator adjustment can create credits).
- Changing a table after a spin does not change that spin's recorded outcome.
