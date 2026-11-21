# 0004. Virtual currency ledger

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: high

## Context and problem statement

Players earn and spend virtual coins. The brief says financially relevant operations must not produce duplicate rewards or negative balances. Coins are a liability the operator is billed against, so the record must be correct and explainable.

## Decision drivers

- Owner: the ledger is tables in the `payments` Postgres database; no files.
- Balance readable from anywhere; every operation (credit, debit, refund) only through `payments`.
- A retried request must not repeat its effect.
- A reviewer must be able to prove "sum of entries equals balance".

## Considered options

1. A balance column updated in place.
2. Append-only entries per account with a materialised balance.
3. Balanced double-entry journal: transactions with two or more legs, debits equal credits.

## Decision outcome

Option 3, with a materialised balance as a cache of the journal.

- `journal_transactions` has business uniqueness `(tenant_id, operation_type, operation_id)`. A repeat of the same business operation returns the original result.
- `journal_legs` are append-only. A deferred constraint trigger requires at least two legs, debits equal to credits, one currency per transaction. Update and delete are not granted to the application role.
- Amounts are integer minor units (`BIGINT`), validated and bounded.
- The balance is updated in the same transaction by a conditional update (`WHERE balance >= :amount`) and a `CHECK (balance >= 0)`. Two concurrent debits cannot both pass.
- Only `payments` exposes write operations. Other services read balances through a read API or a projection. There is no public `credit` route; credits come from validated events (a spin reward) with an operation id.
- A reconciliation job checks that legs sum to the materialised balance and that conservation holds across accounts. A mismatch raises an alert and is never auto-repaired silently.
- Redemption uses holds: a hold reserves coins, capture finalises, release returns them, refund reverses a captured amount (ADR 0006).

### Consequences

Good: every coin has a source and a destination; invariants live in the database, so they hold even if application code is wrong; reconciliation is a query.

Bad: more tables and more write amplification than a balance column; deferred triggers are easy to get wrong, so each guard has a mutation test.

## Pros and cons of the options

- Option 1: no history, no audit trail, lost updates under concurrency.
- Option 2: simple and auditable, but nothing forces both sides of a movement to exist.

## Built vs designed

- Built: journal, legs, trigger, non-negative balance, hold/capture/release/refund, reconciliation query.
- Designed only: operator billing in money (the `fake` payment provider is built; a Stripe adapter is an interface only); multi-currency.
