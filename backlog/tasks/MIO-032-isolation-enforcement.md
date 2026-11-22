---
id: MIO-032
title: 'Isolation enforcement: tenant context, Postgres RLS, composite keys'
epic: EPIC-04
priority: P0
money_impact: enabler
risk_class: isolation
status: todo
depends_on: [MIO-030]
blocked_by: ['starter: tenancy package (context, RLS, isolation test kit)']
size: L
estimate_hours_base: 44
estimate_hours: 53
---

## Goal

Forgetting a tenant filter cannot leak data, because the filter is not optional.

## Scope

- Request-scoped tenant context (async local storage), set by middleware and by message consumers from
  the envelope.
- Every tenant table has `tenant_id`, composite primary and foreign keys `(tenant_id, id)`, and a Postgres
  RLS policy; each transaction runs `SET LOCAL app.tenant_id`.
- RLS policies cover reads and writes: `USING` and `WITH CHECK` on every tenant table, and
  `FORCE ROW LEVEL SECURITY`.
- The application DB role is a separate login role: not a superuser, not the table owner, `NOBYPASSRLS`,
  no `CREATE` on the schema. Migrations run under a different role.
- Repositories cannot be built without a tenant context; a query with an `undefined` tenant throws.
- Unique constraints include `tenant_id`.
- One connection pool per service with a fixed upper bound; the tenant is set per transaction, never by
  choosing a pool.

## Acceptance criteria

- With RLS on and the app filter removed (mutation), a cross-tenant read returns zero rows.
- With the app filter removed, a cross-tenant `INSERT`, `UPDATE` and `DELETE` through the app role fail or
  affect zero rows; an insert in tenant A whose foreign key points at a row of tenant B fails.
- A database-level test, connected as the app role, asserts `rolsuper = false`, `rolbypassrls = false`,
  and that the role owns no table; running the cross-tenant read as that role with `SET LOCAL
app.tenant_id` unset returns zero rows (not all rows).
- Running a repository query outside a tenant context throws, it does not return all rows.
- A migration check fails if any table with a `tenant_id` column has no RLS policy, no `WITH CHECK`, or
  RLS not forced.
- Mutations the reviewer re-applies: grant `BYPASSRLS` to the app role (the role test and the cross-tenant
  read go red); drop `WITH CHECK` from one policy (the cross-tenant insert goes red).
