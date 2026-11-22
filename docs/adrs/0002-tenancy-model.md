# 0002. Tenancy model

Diagram: section [1](../../docs/architecture/README.md#1-context-and-containers), [4](../../docs/architecture/README.md#4-erd-tenancy-and-ledger) of the diagram hub (why each diagram exists: [table](../../docs/architecture/README.md#why-each-diagram-exists)).

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

Status note (2026-11-23): the decision above is kept as written. The code differs in these ways.

- "Every table carries `tenant_id`" holds for every tenant data table, with composite keys. The listed exceptions are the bus tables (`outbox` has primary key `event_id`, `inbox` has `(consumer, event_id)`; neither has RLS, both work across tenants), the platform tables (`signing_keys`, `billing_plans`, `reconciliation_tenants`, no RLS) and `tenants` (RLS enabled but not `FORCE`d; a call with no tenant set sees every tenant). `redemption_work_queue` and `audit_intents` are `FORCE`d with a narrow platform-read branch. The table-by-table list is in `docs/architecture/overview.md` section 3; the bus-table gap is S-27 in the known gaps.
- Acting is not an `acting_tenant` field. It is an acting session: `POST /v1/auth/acting` (reason 8-500 characters) returns a token with an `act: {tenant_id, reason}` claim, and every request under it is audited.
- There is no generated isolation suite. Tests are hand-written isolation tests per service (in-process and compose), RLS-catalog tests that fail on any tenant table without ENABLE+FORCE, DB-role tests, and a mutation per guard.

### Consequences

Good: one schema to migrate per service; cheap onboarding of a tenant (a row, not a database); the failure mode of a forgotten filter is an error, not a leak.

Bad: noisy-neighbour risk in a shared database; per-tenant restore and per-tenant data residency are harder than with database-per-tenant; RLS adds a planning cost on every query and a pooled-connection discipline (`SET LOCAL` inside a transaction only).

## Pros and cons of the options

- Option 1: strongest isolation and simple per-tenant restore, but migrations multiply by tenant count and connection pools do not scale to ten or a hundred tenants.
- Option 3: simplest, but one missed filter leaks data and nothing below the application catches it.

## Built vs designed

- Built: option 2, hand-written isolation tests per service, RLS-catalog tests, DB-role tests, the platform tenant, composite keys on tenant data tables.
- Designed only: moving a large tenant to a dedicated database; per-tenant restore.
