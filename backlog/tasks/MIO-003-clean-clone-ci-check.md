---
id: MIO-003
title: "Clean-clone check in CI: clone, compose up, demo scenario passes"
epic: EPIC-01
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-002, MIO-005]
size: S
---

## Goal

Prove on every change that "clean clone, then `docker compose up`, then the scenario passes, with no
cloud accounts" is true.

## Scope

- CI job that checks out the repo into an empty workspace, with no secrets available to the job.
- Runs `docker compose up -d --wait`, then the scenario script from MIO-005, then `docker compose down -v`.

## Acceptance criteria

- The job is a required status for merging into `main`.
- The job has no secrets or cloud credentials in its environment (asserted by the job itself).
- Breaking any step of the 8-step flow (for example, disabling the spin grant) turns the job red.

## Notes

This is the project's definition of "it works": from a clean checkout, Casino A and Casino B each send a
deposit, the player sees a spin, spins, coins appear in the balance, the player buys in the store, and
the reward reaches `ISSUED` in the casino simulator. The same passes with fault injection, with retries
and compensation. The operator sees a usage-based bill.
