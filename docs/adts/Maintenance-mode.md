# Maintenance mode

> Status: proposed (specced; implementation deferred until Redis/auth/audit land).
> Date: 2026-05-26.

## Context

We need to take the app out of normal service — for breaking DB migrations,
incident response, or scheduled windows — without users seeing half-broken UX,
and **without a redeploy** (env-var flags require one). The app is deployed on a
single VPS, so an operator must be able to flip maintenance **from a remote
machine** (their laptop / CI), not only from inside the running container.

Two flavors are needed:

- **Hard** — all user traffic blocked, "be right back" page served.
- **Read-only** — `GET` works, writes return 503; for expand-contract
  migrations where reads are safe.

## Decision

### Toggle source (single source of truth)

- **Primary: Redis key** `maintenance:mode = off | hard | readonly` — flips in
  milliseconds, read by API/web middleware (cached in-memory 5s to avoid load).
- **Fallback: a settings row in Postgres** for durability across Redis
  restarts. The toggle reader prefers Redis, falls back to DB.
- **Baseline-without-Redis interim:** a sentinel file on a shared volume
  (`/var/run/app/maintenance`) that the middleware stat()s with the same 5s
  cache. This keeps the feature usable before Redis is on the roadmap.

### Remote control (the "VPS daemon, from remote" requirement)

The toggle is flipped remotely through **one authenticated control plane**, not
by SSHing in to edit files by hand:

- **Primary path — admin HTTP endpoint:** `POST /admin/maintenance`
  `{ mode, reason, etaSeconds }`, protected by the `AuthService` admin check +
  a service token. `pnpm maintenance:on|off|readonly` wraps a script that calls
  this endpoint over HTTPS from any machine.
- **Out-of-band path — host control daemon:** a tiny systemd service on the
  VPS host exposes a localhost-only control socket and is driven over SSH
  (`ssh vps app-maintenance hard --reason ... --eta ...`). It writes the
  same toggle (Redis key / sentinel file) so it works **even when the API is
  down** — the case where the HTTP path can't help. The daemon never opens a
  public port; remote access is SSH-authenticated only.

Both paths write the **same** toggle and an audit-log entry.

### Invariants

- **Liveness stays 200** during maintenance: `/healthz/live` reports the process
  is up, so the orchestrator does not restart the container. **Readiness**
  (`/healthz/ready`) follows the standard model — 503 only when a required
  dependency is down — independent of the maintenance toggle. Only user-facing
  routes 503 for the maintenance window; the maintenance page itself is served by
  the web edge middleware + static fallback (below), not gated on API readiness,
  so it is never starved even if the API is pulled from rotation.
- **Admin bypass:** `bypass_maintenance` cookie (set via an admin endpoint) +
  an IP allowlist env fallback, so an operator can verify before lifting.
- **Web reads the toggle directly:** edge middleware checks the toggle source
  (Redis/sentinel) directly, **not** through the API — otherwise the hard-outage
  case (API down) couldn't show the maintenance page. It is **fail-closed**: if
  the toggle is unreadable and the app is unreachable, serve the maintenance page.
- **Static fallback:** web serves `public/maintenance.html` with no JS/CSS deps
  so it renders even if the backend is fully down.

## Alternatives considered

- **Env var + redeploy** — rejected: too slow, defeats incident response.
- **DB-only toggle** — rejected as primary: chicken-and-egg when the DB is what
  you're maintaining; kept as durable fallback.
- **Public admin port on the host** — rejected: extra attack surface; the host
  daemon stays SSH-only / localhost-bound.

## Consequences

- Adds a Redis dependency for the fast path (already on the roadmap).
- Operators get a remote, redeploy-free switch with an out-of-band path for
  total-outage scenarios.
- Every flip is audited (depends on the audit-logs feature).

## Dependencies (blockers for implementation)

- **Auth** — admin check for the toggle endpoint.
- **Audit logs** — record each mode change.
- **Redis** — fast toggle path (sentinel-file interim until then).
