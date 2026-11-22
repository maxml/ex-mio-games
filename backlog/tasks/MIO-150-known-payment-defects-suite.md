---
id: MIO-150
title: Known payment defects regression suite
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: budget
status: todo
depends_on: [MIO-008, MIO-054, MIO-055, MIO-066, MIO-068, MIO-081, MIO-082, MIO-084, MIO-086, MIO-091, MIO-093, MIO-094, MIO-096, MIO-142, MIO-144, MIO-154]
size: L
estimate_hours_base: 40
estimate_hours: 48
---

## Goal

Defects we have seen in earlier payment and credit systems become tests, so they cannot happen again.
Tests come before code in this way: each row is written as a failing test in the test phase of the
mechanism task named in its last column, before that task's code (the mechanism task's start condition,
see "Graph rules" in `backlog/README.md`). This task is the later integration check: it depends on the
mechanisms, collects the rows into one suite, adds the cross-service rows, and runs them together with
the mutation table. Each test sits at the boundary that enforces the rule (the database
constraint, the command handler, the webhook verifier, the entitlement evaluator), not at the call site
where the symptom was first seen.

## Known payment lessons (each row is one named test, `known-payment-defect-NN`)

Rows marked "keep" are good patterns we preserve; the test proves we did not lose them.

| NN | Lesson | What the test does | Enforcing boundary | Mechanism task |
|---|---|---|---|---|
| 01 | Webhook answered 200 on a bad signature | bad, missing, wrong-length and non-hex signatures: 400, no row | webhook verifier | MIO-094 |
| 02 | A client-callable action could mint credits | no player or operator route reaches `credit`; route-table test plus a direct call with a player token: 403 | payments command handler | MIO-082 |
| 03 | Buyer or player id taken from the client | a request carrying another user's id of the same tenant (body, query or header) acts on the caller only; operator staff cannot start checkout for another tenant's customer | principal from token, repository | MIO-082, MIO-093, MIO-154 |
| 04 | Provider redelivery credited twice | same event delivered twice, concurrently to two instances, and after a restart: one effect; inbox row and effect commit together | inbox unique constraint | MIO-094 |
| 05 | Lost update: `balance = balance_read_earlier + n` | 100 parallel mixed credits and holds conserve the total | conditional `UPDATE` in payments | MIO-082 |
| 06 | Payment record and credit in separate transactions | failure injected after journal insert, after balance update, after outbox insert: nothing persists | one database transaction | MIO-082 |
| 07 | Errors swallowed and answered 200, so the provider never retried | handler exception and database outage: non-2xx, retried delivery succeeds; a deferred event is 2xx only after the durable inbox row exists | webhook controller | MIO-094 |
| 08 | Money as a float (`amount / 100`) | `0`, `-1`, `1.5`, overflow, string amount and currency mismatch rejected with no write; schema test finds no float money column | command validation and DB types | MIO-081, MIO-091 |
| 09 | Two plan-to-credits tables that disagreed | one catalog; checkout price equals fulfilled plan for every plan version | plans module | MIO-091 |
| 10 | Environment flag that skipped webhook verification | production-mode boot with any such variable set still verifies; missing secret refuses to start | service config | MIO-094 |
| 11 | Dedupe in a process-global variable | delivery after restart and to a second instance: one effect | durable inbox | MIO-094 |
| 12 | SQL built by string interpolation | payload values containing quotes and SQL fragments are stored verbatim and change nothing else; lint bans raw query strings with template interpolation | repository layer | MIO-008, MIO-082 |
| 13 | Amount or balance trusted from the client | `hold` uses the redemption's price snapshot; `credit` uses the spin's recorded segment; extra amount fields are rejected | command handler | MIO-066, MIO-082 |
| 14 | Effect recorded only in the provider callback (no outbox, no reconciliation) | crash after the casino issued, before recording (MIO-066 boundary 4): recovered by status inquiry; a lost subscription webhook is recovered by a provider status check | saga state and reconciliation | MIO-066, MIO-084, MIO-093 |
| 15 | Refund without a transaction, with a typo | compensation that fails is retried and completes once; release and refund delivered three times: one effect each; conservation holds | hold state machine | MIO-066, MIO-144 |
| 16 | keep: a unique constraint caught a duplicate payout | replay after the HTTP idempotency record expired creates no second redemption or journal transaction | durable business-operation id | MIO-086, MIO-081 |
| 17 | Balance read before the transaction without a lock (double spend); absolute balance write | 50 parallel holds against a balance covering 7: exactly 7 succeed, never negative | conditional `UPDATE` | MIO-082 |
| 18 | `allSettled` over already awaited operations | a multi-leg movement whose second leg fails leaves no leg and no balance change | balanced-legs trigger and one transaction | MIO-081 |
| 19 | Undefined result in a `catch` | every failure path returns a defined error code and leaves state unchanged (checked after each injected failure in rows 06 and 18) | command handler | MIO-082 |
| 20 | Deposit overwrote the balance instead of adding | two distinct credits of 5 and 7 give `+12` | balance update | MIO-081 |
| 21 | keep: timing-safe HMAC compare that never throws | verifier conformance with malformed signatures, for billing and casino webhooks | verifiers | MIO-054, MIO-094 |
| 22 | keep: dedupe by event id and deterministic idempotency keys | equivalent payloads (key order, whitespace) dedupe to one; a changed body with the same key gets 422; the casino issuance key is identical on every retry | canonical hash and key derivation | MIO-055, MIO-086, MIO-142 |
| 23 | keep: retry with backoff | retries are bounded, retryable versus final is a fixed table, and the start-up sweeper recovers after a restart | issuance worker | MIO-068 |
| 24 | In-memory or file-based dedupe | restart and two parallel consumers: one effect | durable inbox | MIO-055, MIO-094 |
| 25 | Usage increment without an idempotency key | the same business operation consumed twice, also in parallel: counted once | entitlement evaluator | MIO-096 |
| 26 | Usage errors returned `null`, so callers failed open | store down: `denied` with reason `unavailable` | entitlement evaluator | MIO-096 |
| 27 | Usage check and increment done separately (race) | 100 parallel consumes against a limit of 10: exactly 10 | entitlement evaluator | MIO-096 |
| 28 | No reconciliation | a corrupted balance and an orphan hold are reported by the next run; the run record is read back correctly | reconciliation job | MIO-084 |

## Acceptance criteria

- One named test per row; the history shows each was red before its mechanism task's code was merged.
- For each test, the reviewer re-applies the defect as a mutation at the enforcing boundary and records
  the red run in the mutation table (guard, mutation, test, red run link).
- A completeness test reads this table and fails if a `known-payment-defect-NN` test is missing.

## Notes

The lessons come from earlier payment, credit and quota code reviewed while planning. They are described
here without naming the projects they came from.
