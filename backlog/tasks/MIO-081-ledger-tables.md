---
id: MIO-081
title: "Ledger tables: append-only entries, integer amounts, no negative balance"
epic: EPIC-08
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-080]
size: M
---

## Goal

The virtual currency ledger cannot express a duplicate effect or a negative balance.

## Scope

- Tables (Postgres, payments DB): `accounts` (player coin account, reserved account, tenant issuance
  account), `ledger_entries` (double-entry: every transaction has balancing debit and credit lines,
  `amount BIGINT > 0`), `balances` (materialised), `idempotency_keys` (`UNIQUE (tenant_id, key)`).
- `CHECK (available >= 0)` and `CHECK (reserved >= 0)` on balances.
- Entries are append-only: no `UPDATE` or `DELETE` grants for the app role; corrections are new entries.
- Balance updates are conditional and atomic: `UPDATE balances SET available = available - $n WHERE
  account_id = $1 AND available >= $n`.

## Acceptance criteria

- The app DB role gets a permission error on `UPDATE ledger_entries` and `DELETE FROM ledger_entries`.
- A debit larger than the balance changes nothing and returns `insufficient_funds`.
- For every transaction, the sum of its lines is zero (DB constraint or trigger, tested).
- No column holding a coin amount is a float type (schema test).
