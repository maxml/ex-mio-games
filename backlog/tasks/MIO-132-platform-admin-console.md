---
id: MIO-132
title: 'Platform admin console: tenants, revenue, usage'
epic: EPIC-13
priority: P1
money_impact: direct
risk_class: ownership
status: todo
depends_on: [MIO-123, MIO-099, MIO-034]
size: M
---

## Goal

MIO staff run the business from one place.

## Scope

Tenant list and status (trial, active, past due, suspended), revenue and MRR (MIO-099), usage per
operator, reconciliation and DLQ status, audited "act as tenant" entry (MIO-034).

## Acceptance criteria

- Only platform roles can open the console (operator token gets 403 on every platform endpoint).
- Opening an operator tenant requires a reason and creates an audit entry.
