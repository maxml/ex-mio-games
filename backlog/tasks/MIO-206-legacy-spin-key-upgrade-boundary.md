---
id: MIO-206
title: Replay of a spin stored under the old raw key after the key format change
epic: EPIC-07
priority: P2
money_impact: none
risk_class: locks
status: todo
depends_on: [MIO-063, MIO-086]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

A client that retries a spin it made before an upgrade must not get a second spin and a second credit.

## Scope

- Before the environment-scoped key format, a spin row stored the raw client key in `operation_id`. After
  the change, a replay computes the new key, misses the old row and spins again.
- Decide with a one-line decision record: either a lookup by the old key as a fallback for a fixed window,
  or a migration that rewrites old rows to the new key, or an explicit note that the deployment has no
  such rows. Implement the chosen path.
- Add the release note: no orders or spins in flight across the upgrade.

## Acceptance criteria

- A test seeds a spin row with the old raw key, replays the same client key, and gets the stored spin back:
  one spin, one credit used, one event.
- If the migration path is chosen: a migration test on a table with old rows ends with every row on the new
  key and no duplicate; running it twice changes nothing.
- If no data exists and the note is chosen: a startup check or migration test fails when an old-format row
  is found.
- Mutation: remove the fallback or the rewrite. The replay test goes red.

## Notes

Source: the early review of the final integration (finding F10, the upgrade boundary; pre-launch, so no
data today). Kept as a task so it is decided before the first real deployment.
