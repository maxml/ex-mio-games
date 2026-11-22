---
id: MIO-105
title: Frontend event relay `POST /v1/events`
epic: EPIC-10
priority: P1
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-101, MIO-133]
size: S
---

## Goal

Browser events reach Varta through our own API, never directly.

## Scope

- Same-origin, session-authenticated endpoint; event names from a frontend allow-list; zod validation;
  batching; rate limit per session.
- Web client: anonymous id, session id, consent hook, batching and retry on reconnect.

## Acceptance criteria

- An event name not on the allow-list returns 422 and is not logged.
- More than the rate limit in a minute returns 429.
- The server sets `tenant_id` and `actor_id` from the session; values sent by the browser are ignored.
