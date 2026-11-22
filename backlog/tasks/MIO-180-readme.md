---
id: MIO-180
title: 'README: setup, assumptions, priorities'
epic: EPIC-17
priority: P1
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-002, MIO-005]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

Deliverable "README with setup instructions and assumptions"; the front page that sells the work.

## Scope

- What it is, in three sentences, and the demo in one command.
- Setup: prerequisites (Docker, Node, pnpm), `git clone --recurse-submodules`, `cp .env.example .env`,
  `docker compose up`, `pnpm demo`.
- Assumptions (simulated casinos, fake payment provider by default, identity emulator, no real money for
  players, no RNG certification, no production infrastructure).
- Links: architecture, ADRs, reliability, fairness, samples, AI evidence, scaling plan, 90-day plan, status.
- Where Varta and Deckhand fit (with screenshots from MIO-184 once approved).

## Acceptance criteria

- A person who has never seen the repo follows the README on a clean machine and the demo passes
  (recorded once by someone other than the author).
- Every link resolves (link check in CI).
