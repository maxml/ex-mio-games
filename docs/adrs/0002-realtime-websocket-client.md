# Realtime: one socket.io client per tab, with reconnect and backoff

> Status: accepted (client side). The server-side gateway is not built yet.
> Date: 2026-11-21.
> Deciders: maintainers.
> Confidence: MEDIUM. The client and the event contracts exist and are tested; the gateway that serves them
> is still to come, so the server half is a design, not shipped behaviour.

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
- **The handshake carries a token** from an injectable getter, re-read on every reconnect so a refreshed
  token is used.
- **Typed events.** Event names and payload shapes are zod schemas in `packages/contracts` (`realtime.ts`).
  Every inbound message is validated before it touches the cache. An emit that gets no ack within 5 s
  rejects instead of hanging.
- **Server side (to build):** a gateway colocated in the `engagement` service, authenticating the handshake
  with the same token the HTTP API uses, with a Redis adapter for more than one instance.

## Consequences

- **Good:** a dropped connection heals itself without a reload; one socket keeps server load flat.
- **Bad:** events missed while disconnected are not replayed; the client refetches instead. Replay is out of
  scope for now.
- **Follow-ups:** mount the provider in `app/providers` once the gateway exists; record the handshake token
  contract in `CONTRACTS.md`.

## Options considered

### One shared socket with backoff (chosen)

- Good, because it is the simplest thing that survives outages.
- Bad, because missed events need a refetch.

### Server-sent events or polling

- Good, because they are stateless on the server.
- Bad, because polling wastes load and adds latency, and SSE is one-way.
