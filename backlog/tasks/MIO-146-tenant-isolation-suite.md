---
id: MIO-146
title: 'Part C: tenant isolation suite'
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: isolation
status: todo
depends_on: [MIO-032, MIO-033]
blocked_by: ['starter: tenancy package (context, RLS, isolation test kit)']
size: M
estimate_hours_base: 20
estimate_hours: 24
---

## Goal

Prove that no tenant can read or change another tenant's data, through any path.

## Acceptance criteria

- Generated per repository and per endpoint: a tenant A actor asking for a tenant B resource gets 404; a
  query without tenant context throws.
- Webhook signed with tenant A's secret sent to tenant B's endpoint: 401.
- Launch token of tenant A cannot open a session in tenant B.
- Cache, broker and websocket paths are covered (from MIO-033).
- The suite enumerates endpoints from the route table, so a new endpoint without an isolation test fails CI.
- Mutation: disable RLS on one table and remove the app filter, then that table's test goes red.
