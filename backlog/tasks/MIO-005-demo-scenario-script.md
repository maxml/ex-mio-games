---
id: MIO-005
title: "One-command demo of the first sellable slice (signup to paid plan, with the 8-step player flow)"
epic: EPIC-01
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-002, MIO-032, MIO-044, MIO-045, MIO-051, MIO-054, MIO-055, MIO-056, MIO-061, MIO-063, MIO-064, MIO-066, MIO-067, MIO-083, MIO-092, MIO-093, MIO-094, MIO-101, MIO-102, MIO-103, MIO-130, MIO-134]
size: M
---

## Goal

The sellable demo: one command walks the first sellable slice (see `backlog/README.md`) from a fresh clone
with no accounts, and prints each step. It is also the executable definition of "it works".

## Scope

`pnpm demo` does, against the compose stack:

1. An operator signs up through the public API (self-serve, `fake` payment provider): tenant, owner and
   trial are created.
2. The operator gets integration keys for Casino A and connects the Casino A simulator.
3. The operator publishes the template configuration: a deposit rule that grants exactly 1 spin for the
   demo deposit, a weighted wheel table and a store item.
4. The Casino A simulator sends a successful deposit event; MIO validates and processes it
   (assignment steps 1 and 2).
5. The player opens the widget from the simulator page with a launch token and receives one spin (step 3).
6. The player spins and gets a server-chosen reward from the weighted table (step 4).
7. The coin reward appears in the ledger (step 5).
8. The player redeems coins in the Bonus Store (step 6); MIO requests issuance through the adapter
   (step 7); the final reward status is read from the API and is `COMPLETED` (step 8).
9. The operator chooses a plan and pays with the `fake` provider; the subscription becomes `active` from
   the verified webhook.
10. The operator funnel and the player funnel for this run are read back with `pnpm analytics:funnel`
    (MIO-102, MIO-103).

The scenario is one function parameterised by casino adapter. Casino B joins it with MIO-052, fault
injection with MIO-053 (`pnpm demo --faults`).

## Acceptance criteria

- Exit code 0 only if every step's expected state is observed through the public API or the funnel
  command (never by reading a service's database).
- Runs from a fresh clone with no cloud accounts and no secrets: Firebase Auth Emulator for identity,
  `fake` payment provider, local simulators.
- Output is short and readable: one line per step with the ids involved, then the funnel counts.
- The assertion set is a single list shared by every casino (no per-casino copies), so adding Casino B
  cannot weaken it.

## Notes

Assignment Part B steps 1 to 8 are steps 4 to 8 here. MIO-003 later enforces the clean-clone run in CI. Also the base for sample responses (MIO-181).
