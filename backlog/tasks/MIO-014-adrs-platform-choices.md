---
id: MIO-014
title: ADRs for platform choices
epic: EPIC-02
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: []
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

Record the platform choices with their reasons, so the team does not reopen them every week.

## Scope

One ADR each in `docs/adrs/`:

- Broker: RabbitMQ. The broker only confirms delivery; state lives in Postgres or Redis. Outbox and inbox
  per service.
- Redis for cache, with persistence so it survives restarts.
- ORM: TypeORM, with migrations that create RLS policies. The ADR states that the architecture does not
  depend on the ORM: isolation, ledger and idempotency rules live in Postgres (policies, constraints,
  roles) and are tested there.
- Identity behind an `IdentityProvider` interface; Firebase Auth Emulator locally; final provider open.
- `PaymentProvider`: `fake` by default, `stripe` behind a key.
- Mandatory websocket between frontend and backend.
- Frontend built only from Storybook components.
- Observability and analytics through Varta; deployment through Deckhand.
- Diagrams as code (archify submodule plus Mermaid), pending owner review.

## Acceptance criteria

- Each ADR has status, context, decision, consequences and Confidence.
- `docs/adrs/README.md` indexes all ADRs.
