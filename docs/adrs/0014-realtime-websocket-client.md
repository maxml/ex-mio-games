# 0014. Realtime: one socket.io client per tab, with reconnect and backoff

- Status: accepted (client and server are built: the gateway lives in `engagement`, namespace `/rt`)
- Deciders: maintainers
- Date: 2026-11-21
- Confidence: MEDIUM. Both halves exist and are tested in process; no end-to-end browser run is recorded
  here. Delivery is at most once and there is no missed-event replay.

## Context

The product needs a websocket between browser and backend: a player's wheel result and balance must appear
without a reload. A connection that dies silently, or that retries in a tight loop after an outage, loses
exactly the moments that matter.

## Decision

- **One shared socket per tab.** `apps/web/src/layers/shared/api/ws` creates a single socket.io client on
  first use (inside a provider effect, never at module scope, because creating one during server rendering
  throws). Components subscribe to events; none opens its own connection.
- **Reconnect with exponential backoff and jitter**: 1 s base, 30 s cap, +/-50 % jitter, give up after 12
  consecutive failures and show the disconnected state. The cap is kept near the server's ping interval so
  client and server agree on when a connection is dead.
- **The handshake carries a one-time ticket** (`aud=realtime`, at most 60 s) fetched over HTTP through the web
  BFF with the session cookie (`GET /api/realtime/ticket`, which proxies identity's `POST /v1/auth/realtime-ticket`).
  The browser never holds the long-lived token. The ticket is fetched again on every reconnect.
- **Typed events.** Event names and payload shapes are zod schemas in `packages/contracts` (`realtime.ts`).
  Every inbound message is validated before it touches the cache. An emit that gets no ack within 5 s
  rejects instead of hanging.
- **Server side (built):** a Socket.IO gateway in the `engagement` service. The middleware redeems the ticket
  through identity's internal route (single use, stored in Postgres); a missing, replayed or refused ticket ends
  the handshake. Rooms are `t:{tenant}:{kind}:{id}`, built on the server only, and the gateway registers no
  client-to-server handler, so a client cannot join a room. `connectionStateRecovery` stays off: in Socket.IO
  4.8 it replays packets before middleware runs, which would skip the ticket check. It pushes spin results,
  balance changes (from payments events) and redemption status, after the handler's transaction commits.
  The web app proxies `/socket.io/*` to engagement. A Redis adapter for more than one engagement instance is next.

## Consequences

- **Good:** a dropped connection heals itself without a reload; one socket keeps server load flat.
- **Bad:** events missed while disconnected are not replayed; the client refetches instead. Replay is out of
  scope for now.
- **Next:** the authenticated journal replay (epoch, journal id) for missed events, and the Redis adapter.

## Options considered

### One shared socket with backoff (chosen)

- Good, because it is the simplest thing that survives outages.
- Bad, because missed events need a refetch.

### Server-sent events or polling

- Good, because they are stateless on the server.
- Bad, because polling wastes load and adds latency, and SSE is one-way.
