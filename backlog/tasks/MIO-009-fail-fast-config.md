---
id: MIO-009
title: Fail-fast configuration and `.env.example` that needs no cloud keys
epic: EPIC-01
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-001]
size: S
---

## Goal

Every service validates its configuration at start-up and refuses to run with a bad one. The defaults
work locally without any external account.

## Scope

- One zod schema per service for its environment.
- `.env.example` with local defaults only: emulator hosts, `PAYMENT_PROVIDER=fake`, local broker and DB.
- Optional keys (for example the Stripe test key) switch features on; their absence keeps the fake path.

## Acceptance criteria

- Starting a service with a missing required variable exits non-zero and names the variable.
- `cp .env.example .env && docker compose up` works with no edits.
- `.env` is in `.gitignore`; a CI check fails if any `.env` file is committed.
