---
id: MIO-081
title: 'Ledger tables: balanced journal transactions, integer amounts, no negative balance'
epic: EPIC-08
priority: P0
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-080, MIO-013]
size: M
---

## Goal

The virtual currency ledger cannot express a duplicate effect, an unbalanced movement or a negative
balance. The database enforces it, so a bug in application code cannot.

## Scope

Tables in the payments database (Postgres):

- `accounts`: `(tenant_id, id)`, `kind` (`player_available`, `player_held`, `tenant_issuance`,
  `tenant_redeemed`), `owner_user_id` for player accounts, `currency` (only `COIN` for now).
- `journal_transactions`: one row per business movement. `(tenant_id, id)`, `operation_type`
  (`spin_award`, `hold`, `capture`, `release`, `refund`, `adjustment`), `operation_id`, `currency`,
  `created_at`, `created_by`. **Business uniqueness:** `UNIQUE (tenant_id, operation_type, operation_id)`,
  where `operation_id` is the durable business-operation id from MIO-086 (the spin id for an award, the
  redemption id for hold, capture, release and refund). This constraint, not a key on each entry, is what
  stops a second effect.
- `ledger_entries`: the legs. `(tenant_id, transaction_id)` foreign key to `journal_transactions`,
  `account_id`, `direction` (`debit` or `credit`), `amount BIGINT CHECK (amount > 0)`, `currency`. Entries
  carry no idempotency key of their own; they belong to exactly one transaction.
- **Balanced legs:** a deferred constraint trigger checks at commit that every transaction has at least
  two legs, that debits equal credits, and that every leg's currency equals the transaction's currency and
  the account's currency.
- `balances` (materialised): `available`, `held` per account, `CHECK (available >= 0)`,
  `CHECK (held >= 0)`. Balance changes are conditional and atomic:
  `UPDATE balances SET available = available - $n, held = held + $n WHERE account_id = $1 AND
available >= $n`. A credit adds to the existing value; no code path writes an absolute balance.
- **Amount validation** at the command boundary and in the database: integer, `> 0`, at most
  `1_000_000_000_000` per transaction; fractional, zero, negative, overflowing or string amounts are
  rejected before any write.
- Append-only: the app role has no `UPDATE` or `DELETE` on `journal_transactions` and `ledger_entries`;
  corrections are new transactions.
- The app role is not a superuser, not the table owner, and has `NOBYPASSRLS` (MIO-032).

## Acceptance criteria

- The app DB role gets a permission error on `UPDATE` and `DELETE` of journal transactions and entries.
- A transaction with one leg, with unequal debits and credits, or with a leg in another currency fails
  at commit (one test each, inserting directly through the app role).
- Two `spin_award` transactions with the same `operation_id`: the second violates the unique constraint
  and the service returns the first one's result.
- A debit larger than the balance changes nothing and returns `insufficient_funds`.
- 50 parallel conditional debits through the app role against a balance covering 7: exactly 7 apply,
  the balance never goes below zero.
- Two distinct credits of 5 and 7 to one account give exactly `+12` (no overwrite).
- Amount boundary cases rejected with no write: `0`, `-1`, `1.5`, `"10"`, `1_000_000_000_001`, and a
  `currency` other than `COIN`.
- No column holding a coin amount is a float or numeric-with-scale type (schema test).
- Mutations the reviewer re-applies: drop the balanced-legs trigger (the unequal-legs test goes red);
  drop the business unique constraint (the duplicate award test goes red); replace the conditional update
  with read-then-write (the parallel-debit test goes red).
