---
id: MIO-149
title: Known tenancy defects regression suite
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: isolation
status: todo
depends_on: [MIO-146]
size: M
---

## Goal

Defects we have seen in earlier multi-tenant systems become tests here before the code exists, so they
cannot happen again.

## Known tenancy defects (each one is a test)

1. Tenant filter optional by default; a forgotten filter leaks data.
2. An `undefined` tenant id in a query condition is silently dropped by the ORM, so the query reads all tenants.
3. Tenant id from the URL is not checked against the tenant in the token.
4. Tenant derived from the `Referer` header; with no header the filter becomes "any tenant"; a super-admin
   can sign in on any tenant's domain.
5. Usernames global across tenants, contradicting "new tenant, new account".
6. The message bus trusts any sender; internal messages return database credentials in plain text.
7. Per-tenant connection cache: race on first access, no eviction, no limit, an error listener added on
   every call.
8. Cache keys without the tenant.
9. Migrations not applied consistently to every tenant's tables.
10. Sensitive request parameters written to debug logs.
11. No isolation tests at all.

## Acceptance criteria

- One named test per defect (`known-tenancy-defect-NN`), each written to fail on the defective behaviour.
- For each test, the reviewer re-applies the defect as a mutation and records the red run.
- Defect 9 here means: a test that every table with `tenant_id` has RLS enabled and forced after all migrations.
