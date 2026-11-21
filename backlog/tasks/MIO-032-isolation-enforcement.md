---
id: MIO-032
title: "Isolation enforcement: tenant context, Postgres RLS, composite keys"
epic: EPIC-04
priority: P0
money_impact: enabler
risk_class: isolation
status: todo
depends_on: [MIO-030]
blocked_by: ["starter: tenancy package (context, RLS, isolation test kit)"]
size: L
---

## Goal

Forgetting a tenant filter cannot leak data, because the filter is not optional.

## Scope

- Request-scoped tenant context (async local storage), set by middleware and by message consumers from
  the envelope.
- Every tenant table has `tenant_id`, composite primary and foreign keys `(tenant_id, id)`, and a Postgres
  RLS policy; each transaction runs `SET LOCAL app.tenant_id`.
- The application DB role is not the table owner and cannot bypass RLS.
- Repositories cannot be built without a tenant context; a query with an `undefined` tenant throws.
- Unique constraints include `tenant_id`.

## Acceptance criteria

- With RLS on and the app filter removed (mutation), a cross-tenant read returns zero rows.
- Running a repository query outside a tenant context throws, it does not return all rows.
- A migration check fails if any table with a `tenant_id` column has no RLS policy.
