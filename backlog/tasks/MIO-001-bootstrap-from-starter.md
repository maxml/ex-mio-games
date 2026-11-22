---
id: MIO-001
title: Bootstrap the product from the monorepo starter (microservices layout)
epic: EPIC-01
priority: P0
money_impact: enabler
risk_class: none
status: todo
depends_on: []
blocked_by:
  ['starter: microservices layout (one container per service)', 'starter: service generator']
size: M
---

## Goal

Generate the product repository from the monorepo starter with the services we need, instead of writing
the platform plumbing by hand.

## Scope

- Services: `identity` (with the tenants module), `engagement` (with the integrations module),
  `payments`, `web`, and one worker per service where needed.
- TypeScript on both frontend and backend; TypeORM for data access (the owner's choice for this
  product; the starter supports Prisma and TypeORM, and the tenancy and ledger guarantees are enforced
  and tested in Postgres, so they do not depend on the ORM).
- Keep the starter's generic packages; product names never go back into the starter.

## Acceptance criteria

- `pnpm install && pnpm nx run-many -t build` succeeds on a fresh clone.
- `pnpm nx show projects` lists `identity`, `engagement`, `payments`, `web`.
- Each service starts on its own (`pnpm nx serve <service>`) and answers `GET /health` with 200.

## Notes

The starter is upgraded first when a capability is generic (any B2B SaaS needs it); product logic stays here.
