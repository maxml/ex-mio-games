# Project brief

## What this is

`ex-mio-games`: a multi-tenant engagement platform for online casinos. A casino (a tenant) connects its
player base; players earn and spend coins in a wheel-spin game; the operator runs it from a console and is
billed per use. The repository holds the full product slice: identity, engagement, payments, a web app
(player widget and operator console) and a simulator of two partner casinos.

## Owner's principles (these decide trade-offs)

1. **Money first.** The first question for any work is whether it helps the product earn money, or lets us
   find out whether it can. Work that does neither waits.
2. **Architecture only for what is expensive to change.** Decide up front the things that would be costly to
   reverse later: service boundaries, tenant isolation, the event envelope, money handling. Everything else
   is done the simplest way, and revisited when it hurts.
3. **Analytics from day one.** Without data we cannot learn anything. Product events are emitted from the
   start (one JSON line per event on stdout, `kind: "product_event"`), but profit still ranks above
   completeness of analytics.
4. **Frontend only from Storybook components.** Design affects revenue, so every screen is assembled from
   components that exist as stories in `packages/ui`. A new element starts as a story.

## Fixed decisions

- TypeScript on both sides. NestJS on Fastify and TypeORM on the back, Next.js on the front.
- One service owns each concern: `identity` (who, and which tenant), `engagement` (rules, wheel, store),
  `payments` (the only place coins change). Coin balances may be read anywhere; every credit, debit or refund
  goes through `payments`.
- Tenants are not a service. A tenant id is a column on every tenant-scoped row, enforced by row-level
  security. The operator console is itself a tenant. A player belongs to exactly one tenant: the user key is
  `tenant_id + user_id`.
- RabbitMQ for events with a transactional outbox and an inbox for dedupe. Acknowledgement is the only
  delivery guarantee we rely on; anything else lives in Redis or the database.
- Redis for cache, with append-only persistence. Every key is prefixed by tenant.
- Money lives in database tables (the ledger), never in files.
- Identity runs on the Firebase Auth Emulator locally, behind an interface so the provider can change. The
  stack must run from a clean clone with no external account.
- Observability and analytics go through Varta; deploys go through Deckhand. This repo only emits to stdout
  and exposes health endpoints and a manifest.

## Out of scope for now

A real payment processor (the interface exists, the default is a fake), a production identity provider
choice, replay of missed websocket events, a full design system beyond the base components.
