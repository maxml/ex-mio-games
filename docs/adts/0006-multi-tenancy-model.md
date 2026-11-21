# Multi-tenancy model (row-level vs schema-per-tenant vs DB-per-tenant)

> Status: **proposed** (needs steer — not yet accepted).
> Date: 2026-08-09.
> Deciders: maintainers (AI-drafted).
> Confidence: MEDIUM (design intent; no tenancy code exists yet).

## Context

The starter has no tenancy model. Adding one is the prerequisite for the whole
SaaS-feature layer identified in
[`../research/saas-boilerplates.md`](../research/saas-boilerplates.md): team/
organization accounts, invitations, RBAC, and **per-seat billing** all depend on
_how_ a tenant is represented and isolated. This ADR picks that representation; it
does **not** specify the build (that is
[`../tasks/future/add-teams-tenancy.md`](../tasks/future/add-teams-tenancy.md)).

Constraints and forces specific to this repo:

- **Microservices-compatibility stance.** The starter shares _contracts, not
  infrastructure_ — each service owns its persistence behind the app-local
  `AppDatabase` facade (see the rejected "shared database package" note in
  `future.txt` and the memory bank). A tenancy model must not assume one global
  shared schema that every service reaches into.
- **Facade discipline.** DB access is behind `AppDatabase`; the tenant scope must
  live at/under that facade, not be sprinkled through controllers.
- **Two ORMs.** Prisma (baseline) and TypeORM (setup choice) must both express
  the model; Mongo is a further setup choice.
- **Auth interaction.** If Better Auth is adopted as an `AuthService` provider
  (see the research doc's auth-standard note), its **organization plugin** brings
  a ready team/membership/invitation model — the tenancy choice should not fight
  that.
- **It must be scaffoldable subtractively/injectably** — tenancy is the
  hardest-to-inject recipe (it touches every model and query), so a simpler model
  is worth a lot.

## Decision

**Proposed: row-level (shared-schema) multi-tenancy** — a `tenantId` (team/org id)
column on every tenant-owned table, with isolation enforced **at the
`AppDatabase` facade** (a tenant-scoped query layer + a request-scoped tenant
context), not per-call in handlers. Postgres **Row-Level Security (RLS)** is an
optional hardening layer for the Prisma/Postgres path; the app-level scope is the
portable baseline (TypeORM/Mongo).

Why it beats the alternatives here: it is the only model that stays simple under
the microservices stance (no per-tenant schema/DB provisioning coupling), works
across Prisma/TypeORM/Mongo, aligns with what the surveyed kits actually ship
(Pegasus `BaseTeamModel`, MakerKit Supabase RLS, Better Auth org plugin are all
row-level), and is the least-bad case for eventual brownfield injection.

**This is a recommendation, not an accepted decision** — see Open questions.

## Consequences

- **Good:** simplest data-model and ops story; one migration path; portable
  across ORMs; composes with Better Auth's org plugin; cheap new-tenant creation
  (a row, not a schema/DB).
- **Bad:** isolation is only as strong as the enforcement layer — a query that
  bypasses the scoped facade leaks across tenants. Mitigations: centralize scope
  in `AppDatabase`; add an ESLint rule / test that fails on unscoped tenant-model
  access; optionally enable Postgres RLS as defense-in-depth. Noisy-neighbor and
  per-tenant data-residency needs are not addressed (would need schema/DB-per-tenant
  for specific tenants — can be a later per-tenant override, not the default).
- **Follow-ups:** register a "tenant scope" contract in
  [`../CONTRACTS.md`](../CONTRACTS.md); the build spec is
  `add-teams-tenancy.md`; RBAC (`future.txt#Auth`) and `add-billing.md` /
  `add-entitlements.md` all depend on this; update the current-context project
  note when accepted.

## Options considered

### Row-level / shared-schema (the proposed one)

- Good: simplest; portable across ORMs; cheap tenant creation; matches Pegasus /
  MakerKit-RLS / Better Auth org plugin; survives the microservices stance.
- Bad: isolation depends on disciplined enforcement (one missed scope leaks);
  weak for hard data-residency / per-tenant-DB compliance asks.

### Schema-per-tenant (one Postgres schema per tenant)

- Good: stronger isolation; per-tenant backup/restore; still one database.
- Bad: migrations must fan out across N schemas (operationally heavy); tenant
  creation provisions a schema; awkward across ORMs and with connection pooling;
  overkill for the default indie/SMB target.

### Database-per-tenant

- Good: strongest isolation; per-tenant residency/scaling; natural fit if a tenant
  later becomes its own service.
- Bad: heaviest ops (N databases, N migrations, connection management); expensive
  tenant creation; contradicts "cheap to start" for the default case. Best offered
  as a **per-tenant override** for enterprise tenants, not the baseline.

## Open questions (need steer)

1. Confirm **row-level** as the default (vs. starting schema-per-tenant).
2. **Single choice or scaffold dimension?** Should the model be fixed, or a
   `setup` dimension (row-level default, schema/DB-per-tenant as opt-in)?
3. **Personal-account model:** is a solo user a degenerate one-member team
   (uniform model, Pegasus-style) or a distinct personal vs team account type
   (MakerKit-style)? This shapes every downstream table.
4. **Better Auth org plugin** as the tenancy source of truth vs. a hand-rolled
   `Team`/`Membership` — decide alongside the auth-provider ADR.
