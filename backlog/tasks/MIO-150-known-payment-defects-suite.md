---
id: MIO-150
title: Known payment defects regression suite
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-082, MIO-094, MIO-096]
size: M
---

## Goal

Defects we have seen in earlier payment and credit systems become tests in payments before the code
exists, so they cannot happen again.

## Known payment defects (each one is a test)

1. Webhook fails open: 200 on a bad signature.
2. A client-callable action can mint credits.
3. The buyer or player id is taken from the client.
4. No idempotency on the provider event id, so redelivery credits twice.
5. Lost update: `balance = balance_read_earlier + n`.
6. The payment record and the credit are not in one transaction.
7. Errors swallowed and answered with 200, so the provider never retries.
8. Money as a float (`amount / 100`).
9. Two different plan-to-credits tables that disagree.
10. An environment flag that skips webhook verification.
11. Deduplication in a process-global variable.
12. SQL built by string interpolation.
13. Amount or balance trusted from the client.
14. Payment recorded only in the provider callback, with no outbox and no reconciliation.
15. Refund without a transaction.
16. Balance read before the transaction without a row lock (double spend).
17. Absolute balance write: a deposit overwrites the balance instead of adding to it.
18. Usage limit check and increment done separately (race); increment without an idempotency key; errors
    swallowed and `null` returned, so the caller fails open.

## Acceptance criteria

- One named test per defect (`known-payment-defect-NN`), each written to fail on the defective behaviour.
- For each test, the reviewer re-applies the defect as a mutation and records the red run.
- Good patterns we keep, each with a test: timing-safe HMAC compare that never throws; dedupe by event id;
  deterministic idempotency keys; backoff; a unique constraint that catches a duplicate payout.
