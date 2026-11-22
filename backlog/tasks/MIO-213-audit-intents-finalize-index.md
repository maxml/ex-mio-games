---
id: MIO-213
title: Audit intent finalize uses an index that leads with the event id
epic: EPIC-15
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-161]
size: S
estimate_hours_base: 4
estimate_hours: 5
---

## Goal

Finishing an audit intent (on every service call) stays cheap as the table grows.

## Scope

- With the primary key `(tenant_id, event_id)`, the finalize statement `DELETE ... WHERE event_id = $1`
  has no index that leads with the event id and scans the table. Either add a unique index on `event_id`
  (a forward migration, in all three services that own the table) or pass the tenant in the statement.
- Keep the row-level security policy of the table unchanged.

## Acceptance criteria

- `EXPLAIN` of the finalize statement on a table of 100,000 rows shows an index scan, not a sequential
  scan (a test reads the plan).
- Finalize of a row of another tenant deletes nothing.
- The migration is forward-only, runs on a table with data, and is added to the migration hash list.
- Finalize time on 100,000 rows stays under 5 ms at the 95th percentile in the test run.

## Notes

Source: the second re-review of the fix round (finding F8: a hot-path cost; event ids are server-minted, so
collisions are theoretical).
