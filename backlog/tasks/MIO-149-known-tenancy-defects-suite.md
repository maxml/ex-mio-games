---
id: MIO-149
title: Known tenancy defects regression suite
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: isolation
status: todo
depends_on: [MIO-015, MIO-030, MIO-031, MIO-032, MIO-033, MIO-034, MIO-043, MIO-146, MIO-160]
size: L
estimate_hours_base: 40
estimate_hours: 48
---

## Goal

Defects we have seen in earlier multi-tenant systems become tests, so they cannot happen again. Tests
come before code in this way: each row is written as a failing test in the test phase of the mechanism
task named in its last column, before that task's code (see "Graph rules" in `backlog/README.md`). This
task is the later integration check: it depends on the mechanisms, collects the rows into one suite and
runs them together with the mutation table. Each test sits at the boundary that enforces the rule (database policy, tenant
context, repository, login), not at the call site where the symptom was first seen.

## Known tenancy lessons (each row is one named test, `known-tenancy-defect-NN`)

| NN | Lesson | What the test does | Enforcing boundary | Mechanism task |
|---|---|---|---|---|
| 01 | Tenant filter optional; a forgotten filter leaks data | with the app filter removed, cross-tenant read, create, update and delete through the app role all fail (zero rows or a policy error); a row of tenant A cannot reference a row of tenant B because foreign keys are composite `(tenant_id, id)` | RLS policies with `WITH CHECK`, composite foreign keys | MIO-032 |
| 02 | An `undefined` tenant id in a query condition was silently dropped, so the query read all tenants | a repository call with an `undefined` or `null` tenant throws before reaching the database | tenant context and repository | MIO-032 |
| 03 | Tenant id from the URL was not checked against the token | a tenant id in path, query, header or body different from the token's is ignored for scope; the delegated `acting_tenant` path has its own rejection test (an acting session for tenant A used on a tenant B URL: 403) | tenant context middleware | MIO-031, MIO-034 |
| 04 | Tenant derived from `Referer`; no header meant "any tenant"; a super-admin could sign in on any tenant's domain | unknown host: 404; `Referer` ignored; platform staff credentials on an operator login page are rejected; first-login, password reset and email verification links are bound to the tenant that issued them | login and tenant resolution | MIO-031, MIO-043 |
| 05 | Usernames global across tenants | there are no usernames: sign-in is by email (staff) or launch token (players); the same email registers independently in two tenants; a unique index without `tenant_id` fails the schema test | identity schema | MIO-030, MIO-043 |
| 06 | The message bus trusted any sender, and internal replies carried database credentials | a message from a producer not allowed for that type goes to the DLQ; a schema test fails if any reply or event contract has a field for credentials or connection strings; reply payloads in tests are scanned for secret-like values | broker permissions and contracts | MIO-015, MIO-033 |
| 07 | Per-tenant connection cache: race on first access, no eviction, no limit, an error listener added on every call | the product uses one pool per service (not per tenant): a test opens 200 tenant contexts concurrently and asserts one pool, a bounded connection count and a constant listener count | database client module | MIO-032 |
| 08 | Cache keys without the tenant | the same logical key written in tenant A and read in tenant B misses; a background job restores the tenant from the envelope, and two concurrent jobs for different tenants never see each other's context | cache wrapper and job context | MIO-033 |
| 09 | Migrations not applied consistently | after all migrations, every table with `tenant_id` has RLS enabled and forced; a migration run that fails halfway can be re-run to completion; an expand-then-contract change keeps the previous service version working | migration check | MIO-032 |
| 10 | Sensitive request parameters written to debug logs | requests and events containing an email, a launch token, a webhook signature, an integration secret and a casino player id are processed at debug level; the log sink and the trace exporter are read back and contain none of them | logger and telemetry redaction | MIO-160 |
| 11 | No isolation tests at all | the generated isolation suite enumerates every route and repository; a new route without an isolation test fails CI; removing one guard turns its test red | isolation suite | MIO-146 |

## Acceptance criteria

- One named test per row; the history shows each was red before its mechanism task's code was merged.
- For each test, the reviewer re-applies the defect as a mutation at the enforcing boundary and records
  the red run in the mutation table (guard, mutation, test, red run link).
- A completeness test reads this table and fails if a `known-tenancy-defect-NN` test is missing.

## Notes

The lessons come from an earlier multi-tenant system reviewed while planning. They are described here
without naming it.
