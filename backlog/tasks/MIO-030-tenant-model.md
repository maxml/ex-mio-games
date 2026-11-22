---
id: MIO-030
title: 'Tenant model: platform tenant, operator tenants, tenants module inside identity'
epic: EPIC-04
priority: P0
money_impact: enabler
risk_class: isolation
status: todo
depends_on: [MIO-040, MIO-013]
blocked_by: ['starter: tenancy package (context, RLS, isolation test kit)']
size: M
---

## Goal

A tenant registry that operator self-serve onboarding (MIO-092) can create tenants in.

## Scope

- Tenant types: `platform` (MIO staff, exactly one) and `operator` (one per casino operator).
- Tenant fields: id, type, display name, status (`trial`, `active`, `suspended`), domains, created at.
- User key `(tenant_id, user_id)`; email and username are unique within a tenant, not globally.
- No tenant picker: a person who joins another tenant registers again there.
- Tenant creation publishes `tenant.created` through the outbox.

## Acceptance criteria

- Creating a second `platform` tenant fails.
- The same email can register in two operator tenants and gets two different `user_id`s.
- Tenant creation and the outbox row are written in one transaction (killing the process between them
  leaves neither).
