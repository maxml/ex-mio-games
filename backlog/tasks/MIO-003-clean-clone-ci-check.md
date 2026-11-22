---
id: MIO-003
title: "Clean-clone check in CI: clone, compose up, demo passes, no accounts"
epic: EPIC-01
priority: P1
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-002, MIO-005, MIO-006]
size: S
---

## Goal

Prove on every change that "clean clone, then `docker compose up`, then the scenario passes, with no
cloud accounts" is true. The demo itself (MIO-005) is in the first sellable slice; this job keeps it true.

## Scope

- CI job that checks out the repo into an empty workspace, with no secrets available to the job.
- Runs `docker compose up -d --wait`, then `pnpm demo`, then `docker compose down -v`.
- After images are pulled, outbound network from the stack is limited to the compose network, so a
  hidden dependency on a cloud service fails the run instead of passing silently.

## Acceptance criteria

- The job is a required status for merging into `main`.
- The job has no secrets or cloud credentials in its environment (asserted by the job itself: it lists
  environment variable names and fails on any that look like keys or tokens).
- A deliberate outbound call to a public host from any service makes the job fail (negative test run once
  and recorded).
- Breaking any step of the demo (for example, disabling the spin grant) turns the job red.
- Once MIO-052 and MIO-145 are done, the job also runs Casino B and `pnpm demo --faults`.

## Notes

This is the project's definition of "it works" (approved by the owner): from a clean checkout, Casino A
and Casino B each send a deposit, the player sees a spin, spins, coins appear in the balance, the player
buys in the store, and the reward reaches the final issued state in the casino simulator. The same passes
with fault injection, with retries and compensation. The operator sees a bill.
