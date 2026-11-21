---
id: MIO-005
title: One-command demo scenario script (the 8-step flow for both casinos)
epic: EPIC-01
priority: P0
money_impact: direct
risk_class: none
status: todo
depends_on: [MIO-004, MIO-051, MIO-052, MIO-063, MIO-066, MIO-067]
size: M
---

## Goal

The sellable demo: one command walks the whole assignment workflow for both casinos and prints each step.

## Scope

`pnpm demo` (and `pnpm demo --faults`) does, for Casino A and then Casino B:

1. The casino simulator sends a successful deposit event.
2. MIO validates and processes it.
3. The player receives one spin.
4. The player spins and gets a server-chosen reward from the weighted table.
5. The coin reward appears in the ledger.
6. The player redeems coins in the Bonus Store.
7. MIO requests issuance through the casino adapter.
8. The final reward status is read from the API.

## Acceptance criteria

- Exit code 0 only if every step's expected state is observed through the public API (not by reading the DB).
- With `--faults`, the simulator injects a timeout and a failed issuance; the script still ends with one
  `ISSUED` reward and one `FAILED` reward whose coins were refunded.
- Output is short and readable: one line per step with the ids involved.

## Notes

Assignment Part B steps 1 to 8. Also used by MIO-003 and as the base for sample responses (MIO-181).
