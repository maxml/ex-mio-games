---
id: MIO-017
title: Technology choices explained
epic: EPIC-02
priority: P1
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-014]
size: S
estimate_hours_base: 3
estimate_hours: 4
---

## Goal

The assignment says "you may use any reasonable technology stack, but explain your choices".

## Scope

A section in `docs/architecture/README.md` (one table): TypeScript everywhere, NestJS services, Next.js
web, Nx monorepo built from the monorepo starter, Postgres, TypeORM, RabbitMQ, Redis, Firebase Auth
Emulator behind an interface, Stripe behind an interface, Storybook, Varta, Deckhand, Docker Compose.

## Acceptance criteria

- Each row: what it is used for, why it was chosen, what we would switch to and when.
- Each row links its ADR when one exists.
