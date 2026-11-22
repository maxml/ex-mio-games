---
id: EPIC-14
title: Reliability and security test suite (assignment Part C)
priority: P1
status: todo
---

# EPIC-14 Reliability and security test suite

## Goal

Every Part C case is an automated test that runs in CI and can be shown live. Financially relevant
operations never produce duplicate rewards or negative coin balances. Each guard has a mutation: remove
the guard and its test goes red.

## Tasks

| ID | Title | Risk class |
|---|---|---|
| MIO-140 | Duplicate deposit events | admission |
| MIO-141 | Concurrent spin requests | concurrency |
| MIO-142 | Duplicate redemption requests | locks |
| MIO-143 | External API timeouts | concurrency |
| MIO-144 | Failed reward issuance and compensation | budget |
| MIO-145 | Retries and eventual recovery | concurrency |
| MIO-146 | Tenant isolation suite | isolation |
| MIO-147 | Invalid or unauthorized events | guard |
| MIO-148 | Ledger invariant property test | budget |
| MIO-149 | Known tenancy defects regression suite | isolation |
| MIO-150 | Known payment defects regression suite | budget |
| MIO-151 | Reward probability manipulation and unauthorized spins | guard |
| MIO-152 | Rate limiting on ingest, spin and redeem | guard |
| MIO-153 | `docs/reliability.md`: each case, its test, how to run it | none |
| MIO-154 | Same-tenant hostile player cannot touch another player's spins, coins or rewards | ownership |

## How tests are written here

The test author writes these tests before the code, and they must fail first. The reviewer adds a
regression test at the choke point (where a bad value cannot be constructed) and re-applies one mutation
per claimed guard.
