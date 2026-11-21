---
id: EPIC-04
title: Tenancy
priority: P0
status: todo
---

# EPIC-04 Tenancy

## Goal

Many casino operators share one deployment and never see each other's data. The platform admin is a
tenant of its own. A user is identified by `(tenant_id, user_id)`; a person who joins another tenant
registers again there. There is no tenant picker.

## Why it matters for money

Every paying operator is a tenant. One cross-tenant leak ends the business.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-030 | Tenant model: platform tenant, operator tenants, tenants module inside identity | P0 |
| MIO-031 | Tenant resolution from domain or casino launch token only | P0 |
| MIO-032 | Isolation enforcement: tenant context, Postgres RLS, composite keys | P0 |
| MIO-033 | Tenant in cache keys, broker envelopes and websocket channels | P1 |
| MIO-034 | Platform admin acts in an operator tenant only through explicit, audited `acting_tenant` | P1 |

Isolation tests are in EPIC-14 (MIO-146, MIO-149).

## Decisions already made

- Tenants are a module inside the identity service, not a separate service.
- Shared database per service, `tenant_id` on every row, Postgres row-level security.
