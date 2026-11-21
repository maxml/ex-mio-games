# 0002. Tenancy model

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: high for the model, medium for the RLS operational details

## Context and problem statement

Casino operators are tenants. The platform's own admin console is also a tenant. A player belongs to exactly one tenant and cannot choose it. Isolation failures are the most damaging class of defect in a multi-tenant product, so the model must make a cross-tenant read hard to write, not merely forbidden by convention.

## Decision drivers

- Owner decisions: one shared database per service, admin is a platform tenant, user key is `(tenant_id, user_id)`, a person registers anew on each tenant.
- Tenant must never come from a client-controlled field (header, body, Referer).
- A missing tenant context must fail, not return everything.
- Isolation must be testable in the database, independent of application code.

## Considered options

1. Database or schema per tenant.
2. Shared database per service, `tenant_id` column, Postgres row-level security (RLS), request context in AsyncLocalStorage.
3. Shared database, `tenant_id` filtering in application code only.

## Decision outcome

Option 2.

- Every table carries `tenant_id`; primary and foreign keys are composite `(tenant_id, id)`, so a row cannot reference another tenant's row.
- Each transaction runs `SET LOCAL app.tenant_id = ...`; RLS policies use `USING` and `WITH CHECK`, and are `FORCE`d. The application role is not a superuser, not the table owner, and has `NOBYPASSRLS`.
- AsyncLocalStorage carries the tenant context through a request. The repository layer throws when the context is missing.
- The tenant is derived from the verified launch token or the verified session key, never from request fields.
- The admin console is the `platform` tenant. Acting inside an operator tenant requires an explicit `acting_tenant` that is written to the audit log. There is no implicit "tenant is null means everything" rule.
- A user is identified by `(tenant_id, user_id)`. Email is unique per tenant. The same person on a second tenant is a new account.
- Redis keys and broker messages carry `tenant_id` in the key or envelope; consumers restore the context before acting.
- Uniqueness checks include the tenant (RLS does not enforce uniqueness across rows it hides).
- Tests: a generated isolation suite for every repository (foreign tenant gets 404; no context gets an error), DB-role tests, and a mutation that removes each guard and must turn a test red.

### Consequences

Good: one schema to migrate per service; cheap onboarding of a tenant (a row, not a database); the failure mode of a forgotten filter is an error, not a leak.

Bad: noisy-neighbour risk in a shared database; per-tenant restore and per-tenant data residency are harder than with database-per-tenant; RLS adds a planning cost on every query and a pooled-connection discipline (`SET LOCAL` inside a transaction only).

## Pros and cons of the options

- Option 1: strongest isolation and simple per-tenant restore, but migrations multiply by tenant count and connection pools do not scale to ten or a hundred tenants.
- Option 3: simplest, but one missed filter leaks data and nothing below the application catches it.

## Built vs designed

- Built: option 2, the isolation suite, DB-role tests, the platform tenant, composite keys.
- Designed only: moving a large tenant to a dedicated database; per-tenant restore.
