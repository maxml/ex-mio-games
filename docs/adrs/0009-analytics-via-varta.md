# 0009. Product analytics through Varta, with an honest delivery guarantee

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: medium

## Context and problem statement

Without data the product cannot learn what earns money, so analytics are designed in from the start. The owner wants one panel for all analytics and wants Varta, the observability and analytics project, to be it. Today Varta ingests events as JSON lines on stdout, keeps data for a limited time, and its written scope still says it is not a product-analytics tool. That scope has to be amended on the Varta side.

## Decision drivers

- One panel, one place for logs, metrics, traces and product events.
- No new runtime dependency that fails when Varta is down.
- Honest numbers: funnels and billing must not double count.
- Privacy: no personal data in events; opaque ids only.

## Considered options

1. A separate product-analytics tool next to Varta.
2. Product events as structured JSON lines on stdout, collected by Varta.
3. Push events to Varta over a network protocol from application code.

## Decision outcome

Option 2.

- Each event is one JSON line through the existing structured logger: `kind: "product_event"`, `event`, `event_v`, `event_id` (a lower-case UUIDv7, the only shape Varta keeps), `tenant_id`, opaque actor id, allow-listed flat properties.
- **Two classes.** Business events (deposit processed, spin, redemption state, billing) are written through the transactional outbox and are at-least-once, so a crash cannot silently drop them. Behavioural events (UI interactions) are best effort and are never used for funnels or billing.
- **The guarantee is exactly-once counting, not exactly-once delivery.** The same `event_id` may appear twice; readers count distinct `event_id`. The `event_id` stays a UUIDv7 and is not derived from tenant, step and business id: Varta deletes any other shape. Any determinism (one event per business fact) goes into a separate prop or the idempotency layer, never into the `event_id`.
- Frontend events go to the product's own API (same origin, session-authenticated, allow-listed names, validated, rate-limited) and are logged server-side.
- Dashboards live in Varta, one panel. No personal data in events.

### Consequences

Good: no coupling to Varta availability, one panel, honest metrics.

Bad: stdout lines are not a durable queue, so an event can be lost between the log line and Varta ingestion; the dedicated `product_events` stream and its longer retention now exist in Varta. Every service needs a relay for business events, and a relay outage delays funnels.

## Built vs designed

- Built: the event contract (`ProductEventLine`, matching Varta's product-event schema, with a conformance test against a vendored copy) and the logger function `logProductEvent`.
- Built: identity, engagement, payments and the web backend emit 12 product events to stdout (`docs/analytics.md`), and the ingest path is verified and conformance-checked against Varta's schema; the events reach Varta when MIO is deployed with the varta labels (`docs/observability/varta.md`).
- Next: emission of business events through the outbox, distinct-count reads, and the Varta-side funnel view. The submission writes events to stdout under Varta's contract and does not modify Varta.
