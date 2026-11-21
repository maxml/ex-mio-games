# Optional shared Redis

> Status: done.
> Date: 2026-06-30.
> Deciders: template maintainers / AI.
> Confidence: HIGH (explicit in code).

## Context

Several roadmap features (maintenance-mode toggle, scheduled tasks/BullMQ, rate
limiting) need a fast, shared, out-of-process store. There is no point in each
wiring its own client. The baseline must also stay runnable with zero extra
infrastructure for local development, and the scaffolder must be able to remove
Redis cleanly for projects that do not want it. The production `DATABASE_URL`
TLS guard sets the precedent that shared infra must use TLS in production.

## Decision

Add a small `apps/api/src/redis` facade (`RedisCache`: typed `get`/`set`/`del`
with TTL, `ping`, and a raw `client()` accessor for pub/sub) backed by
**ioredis**, behind a setup dimension `redis`.

- **ioredis over node-redis** — it matches the planned WebSocket adapter
  (`@socket.io/redis-adapter` expects an ioredis-style client) and the legacy
  stack the template draws on; its `lazyConnect` + per-request retry options make
  graceful, optional connection trivial.
- **Optional / lazy** — `getCache()` returns `null` when `REDIS_URL` is unset, so
  the API boots and runs with no Redis. The client is constructed with
  `lazyConnect` and an error listener, so an unreachable Redis degrades a health
  check instead of crashing the process.
- **Readiness independence** — Redis is reported in `GET /healthz` (status +
  latency) but a Redis outage only marks the report `degraded`; it never returns
  503 and never affects `/healthz/live` or `/healthz/ready`. Readiness depends on
  Redis only if/when a feature makes Redis genuinely required.
- **Production TLS** — when `REDIS_URL` is set in production the config guard
  requires `rediss://` or `tls=true`, mirroring the `DATABASE_URL` guard.

## Consequences

- **Good:** one swappable boundary for every future Redis consumer; local dev
  needs no Redis; a project can opt out and leave no references.
- **Bad:** `ioredis` is a baseline dependency even though the facade may be
  unused until `REDIS_URL` is set; removed only when the `redis` dimension is off.
- **Eviction / persistence:** the compose `redis:7` service uses Redis defaults
  (no eviction policy, RDB persistence on a named volume) — fine for local dev;
  production deployments should set `maxmemory`/`maxmemory-policy` per use case.
- **Follow-ups:** unblocks later maintenance-mode and scheduled-tasks work. The `/healthz` `redis` entry rides the existing open
  `checks` record in the `HealthCheck` schema, so no shared-types change was
  needed.

## Options considered

### ioredis (chosen)

- Good, because it matches the WebSocket pub/sub adapter and legacy stack, and
  has first-class lazy-connect / retry controls for optional use.
- Bad, because the API surface is larger than node-redis and types are heavier.

### node-redis (`redis`)

- Good, because it is the "official" client and lighter.
- Bad, because the planned socket.io adapter and existing code assume an
  ioredis-shaped client; choosing it would force shims later.
