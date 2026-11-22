# 0010. TypeORM for persistence

Diagram: section [4](../../docs/architecture/README.md#4-erd-tenancy-and-ledger) of the diagram hub (why each diagram exists: [table](../../docs/architecture/README.md#why-each-diagram-exists)).

- Status: accepted
- Deciders: product owner (maxml)
- Date: 2026-11-21
- Confidence: medium

## Context and problem statement

Each service needs a typed data layer on Postgres, with migrations. The architecture puts its important guarantees (RLS, constraints, triggers, roles) in the database, so the ORM is a convenience, not a foundation.

## Decision drivers

- Owner: TypeORM, "no need to invent anything".
- NestJS integration is first class.
- Raw SQL must stay easy for RLS, deferred triggers and conditional updates.
- Server data access stays in the model layer, with services holding application logic (simple MVC).

## Considered options

1. TypeORM.
2. Prisma.
3. A query builder with hand-written migrations.

## Decision outcome

Option 1, TypeORM, because the owner chose it, it integrates with NestJS first class, and it leaves raw SQL easy for RLS, triggers and conditional updates, which carry the real guarantees. Prisma would add a schema language and a generated client that sit awkwardly beside hand-written RLS migrations; a bare query builder would mean writing the model layer ourselves. Entities and repositories form the model layer; controllers validate input with zod and hold the request-level checks; services hold application logic only.

- RLS policies, triggers, roles and grants are written as SQL migrations, not inferred from entities.
- Every transaction that touches tenant data runs `SET LOCAL app.tenant_id` through one helper, so the context cannot be forgotten at a call site.
- Money paths use explicit queries (`UPDATE ... WHERE balance >= :amount`) rather than read-modify-write.
- The architecture is independent of the ORM: isolation, ledger and idempotency are tested against Postgres, so replacing the ORM does not change the guarantees.

### Consequences

Good: no new decision, familiar to most NestJS developers, good enough migrations.

Bad: weaker typing of complex queries than some alternatives; the active-record patterns invite logic in entities, which the layering rule forbids; lazy relations and implicit transactions need discipline.

## Built vs designed

- Built: TypeORM in every service with SQL migrations for policies and constraints.
- Designed only: a migration to another ORM (not planned).
