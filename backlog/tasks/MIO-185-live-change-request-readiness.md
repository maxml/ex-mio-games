---
id: MIO-185
title: Live change request readiness
epic: EPIC-17
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-057, MIO-060]
size: S
---

## Goal

The assignment ends with "a short live change request". Make the likely changes fast and safe.

## Scope

`docs/howto/` short guides, each with the files to touch and the tests to run:

- add a third casino platform adapter;
- add a new rule condition or action (for example "first deposit only" or "grant coins directly");
- add a new store reward type;
- add a new event to the analytics taxonomy;
- change a wheel table and prove old spins still verify.

## Acceptance criteria

- Each guide was followed once by an agent from a fresh session and the resulting change passed CI; the
  time taken is recorded in the guide.
