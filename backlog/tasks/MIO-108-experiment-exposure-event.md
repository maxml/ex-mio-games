---
id: MIO-108
title: Experiment exposure event
epic: EPIC-10
priority: P3
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-101]
size: S
---

## Goal

Run A/B tests later (for example on wheel tables or store prices) with analysis in the same store.

## Scope

`experiment.exposed {key, variant}` event and a minimal assignment helper (hash of `actor_id` and key).

## Acceptance criteria

- The same actor and key always get the same variant.
- Exposure is emitted once per actor per experiment.

## Notes

Can be done later.
