---
id: MIO-183
title: First 90-day engineering plan
epic: EPIC-17
priority: P1
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-187]
size: S
---

## Goal

Deliverable "first 90-day engineering plan", ordered by profit impact.

## Scope

`docs/plan-90-days.md` in three blocks of about 30 days, each with goals, measurable outcomes and risks:

- Days 1 to 30: production entry conditions, then the first paying pilot operator: the identity
  provider decision and its production adapter (MIO-041), the deployment security review, backups with
  a restore drill; then a real casino integration through an adapter, onboarding, billing live,
  analytics funnel watched. The local emulator is enough for the demo, not for a real pilot.
- Days 31 to 60: production hardening (SLOs, alerts, on-call, security review follow-ups) and the second
  operator.
- Days 61 to 90: first new engagement feature (Missions) on canonical events, team growth, AI-assisted
  process measured (review findings per change, escaped defects).

## Acceptance criteria

- Each block has at least two measurable outcomes (for example: "one operator on a paid plan", "p95
  issuance latency under 2 s").
- The plan names what is deliberately not done in the 90 days.
- It answers Part E question 4 directly and is consistent with the production milestones in MIO-187.
