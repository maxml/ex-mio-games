---
id: MIO-218
title: Daily backup schedule for pre-production and production
epic: EPIC-15
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-163]
size: S
estimate_hours_base: 5
estimate_hours: 6
---

## Goal

Databases are backed up every day, not only before a migration. Deckhand's pre-migration dump
(`deploy/backup.sh`) covers a deploy; it does not cover a day with no deploy.

## Scope

- A daily schedule (a timer or cron entry on the host) that runs the same per-database dump and keeps a
  fixed number of days.
- A check that the last run succeeded and the dump is not empty, visible as an alert when it is not.

## Acceptance criteria

- On pre-production, a dump per database exists for each of the last N days.
- Stopping the schedule or emptying a dump raises the alert within one day.
- The restore drill uses a scheduled dump, not only a pre-migration one.

## Notes

Related: the backup and restore drill in the 90-day plan, weeks 1 and 2.
