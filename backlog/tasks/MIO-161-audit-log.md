---
id: MIO-161
title: Audit log for financial and admin actions
epic: EPIC-15
priority: P1
money_impact: enabler
risk_class: ownership
status: todo
depends_on: [MIO-032]
blocked_by: ["starter: audit module (append-only, same-transaction write, reader API)"]
size: M
---

## Goal

Assignment Part A: auditability. Who did what, in which tenant, and why.

## Scope

- Append-only `audit_log` per service: actor (user or service), acting tenant, action, object, before and
  after (for configuration), reason, correlation id, time.
- Written in the same transaction as the action it records.
- Covered actions: rule, table and store changes; manual coin adjustments; key creation and rotation; plan
  changes; acting-tenant sessions; redemption replays.
- Operator console and platform console views, filtered by tenant.

## Acceptance criteria

- Each covered action has a test that asserts exactly one audit row with the right actor.
- The app role cannot update or delete audit rows.
- Reader test: the console view returns the row written by the action, described correctly.
