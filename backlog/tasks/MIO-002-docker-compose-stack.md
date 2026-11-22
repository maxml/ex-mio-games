---
id: MIO-002
title: "Docker Compose stack: one container per service plus infrastructure"
epic: EPIC-01
priority: P0
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-001]
blocked_by: ["starter: microservices layout (one container per service)", "starter: Redis with persistence"]
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

`docker compose up` brings up the whole product locally and reproducibly.

## Scope

- One container per service: `identity`, `engagement`, `payments`, `web`, workers.
- Infrastructure: Postgres (one database per service), RabbitMQ, Redis with persistence (AOF), Firebase
  Auth Emulator, `casino-a-sim`, `casino-b-sim`.
- Health checks and `depends_on: condition: service_healthy` so start order is deterministic.
- Each service can be started alone (`docker compose up payments`).

## Acceptance criteria

- `docker compose up -d --wait` exits 0 on a clean machine with only Docker installed.
- Restarting Redis keeps keys written before the restart (persistence test).
- `docker compose up payments` starts only payments and its own dependencies.
- No image needs a cloud account or a key to start.

## Notes

Assignment: "Docker Compose is preferred for reproducible local execution."
