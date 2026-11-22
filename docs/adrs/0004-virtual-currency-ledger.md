# 0004. Virtual currency ledger

Diagram: section [2](../../docs/architecture/README.md#2-sequence-the-8-step-workflow), [3](../../docs/architecture/README.md#3-workflow-redemption-saga-with-compensations), [4](../../docs/architecture/README.md#4-erd-tenancy-and-ledger) of the diagram hub (why each diagram exists: [table](../../docs/architecture/README.md#why-each-diagram-exists)).

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
- `ledger_entries` (the legs) are append-only. A deferred constraint trigger requires a balanced transaction (debits equal to credits). Update and delete are not granted to the application role; a balance row can change only its amount and a reserve only its state (column-level grants).
- Amounts are integer minor units (`BIGINT`), validated and bounded.
- The balance is updated in the same transaction by a conditional update (`WHERE balance >= :amount`) and a `CHECK (balance >= 0)`. Two concurrent debits cannot both pass.
- Only `payments` exposes write operations. Other services read balances through a read API or a projection. There is no public `credit` route; credits come from the `spin.completed` event with the operation id `spin:<spin_id>`. An acting (support) token is refused on every coin route.
- A reconciliation job (periodic in the payments worker, and a CLI) checks that entries sum to the materialised balance and that conservation holds across accounts. A mismatch is recorded and reported, with exit code 1 from the CLI; it is never auto-repaired. There is no pager integration (Partial).
- Redemption uses reserves: a reserve holds coins, capture finalises, release returns them, refund reverses a captured amount (ADR 0006). The reserve is a synchronous internal API, idempotent by the state of the reserve id.

Status note (2026-11-23): credits are not keyed `spin:<spin_id>` in the ledger. Payments credits a spin under the ledger key `(operation_type 'spin_award', operation_id <spin_id>)` with `UNIQUE (tenant_id, operation_type, operation_id)`. `spin:` is engagement's scoped-key kind for the spin operation, a different thing. Reserve, capture, release and refund are synchronous HTTP calls from engagement.

### Consequences

Good: every coin has a source and a destination; invariants live in the database, so they hold even if application code is wrong; reconciliation is a query.

Bad: more tables and more write amplification than a balance column; deferred triggers are easy to get wrong, so each guard has a mutation test.

## Pros and cons of the options

- Option 1: no history, no audit trail, lost updates under concurrency.
- Option 2: simple and auditable, but nothing forces both sides of a movement to exist.

## Built vs designed

- Built: journal, entries, trigger, non-negative balance, reserve/capture/release/refund, reconciliation job and CLI, the `fake` payment provider for operator plan billing.
- Next: a real payment provider (Stripe exists only as a port and a stub that throws); multi-currency.
