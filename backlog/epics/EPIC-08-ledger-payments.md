---
id: EPIC-08
title: Coin ledger in the payments service
priority: P0
status: todo
---

# EPIC-08 Coin ledger in the payments service

## Goal

All money and value live in one payments service. Any service may read a coin balance, but every coin
operation (credit, debit, reserve, refund) goes through payments. The ledger is a set of Postgres
tables in the payments database: append-only, integer amounts, no negative balances, no duplicate effects.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-080 | Payments service skeleton with its own database | P0 |
| MIO-081 | Ledger tables: balanced journal transactions, integer amounts, no negative balance | P0 |
| MIO-082 | Coin operations API: credit, hold, capture, release, refund, all idempotent | P0 |
| MIO-083 | Balance readable everywhere (read API, cache, change event) | P0 |
| MIO-084 | Reconciliation job and ledger conservation report | P1 |
| MIO-085 | Ledger history API for players and operators | P1 |
| MIO-086 | Idempotency contract for value operations: scoped keys, durable business-operation ids | P0 |
| MIO-198 | Behaviour test that the internal balance read refuses a request without an environment | P1 |

Ledger property tests and the known payment defects suite are in EPIC-14 (MIO-148, MIO-150).

## Covers

Part A (virtual currency ledger), Part B step 5, Part C ("no duplicate rewards or negative coin balances").
