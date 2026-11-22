---
id: MIO-046
title: Service-to-service authentication
epic: EPIC-05
priority: P0
money_impact: enabler
risk_class: guard
status: todo
depends_on: [MIO-042]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Only engagement can ask payments to move coins; nothing else on the network can.

## Scope

- Identity issues service tokens (client credentials) with `aud` and a fixed scope per caller.
- Payments coin-operation endpoints accept only the engagement service token with scope `coins:write`.
- Broker consumers check that the message came from the expected publisher (publisher id in the envelope,
  per-service broker users).

## Acceptance criteria

- A call to `POST /internal/coins/credit` with a player or operator token gets 403.
- A call with the engagement token but without `coins:write` gets 403.
- A message published with the wrong broker user is refused by RabbitMQ permissions (integration test).
