# 0003. RabbitMQ with transactional outbox and inbox

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: high

## Context and problem statement

Services own separate databases, so facts cross service boundaries as events. A message broker is mandatory (owner decision). The broker must not be the system of record, and a message must not be lost or applied twice when a service crashes between its database commit and its publish.

## Decision drivers

- Owner: "acknowledgement of receipt is enough for me; everything else lives in Redis or the database."
- Both producer and consumer can crash at any point.
- Delivery is at least once at best; effects must be exactly once.
- Small operational footprint for a local clean-clone setup.

## Considered options

1. Kafka API (Redpanda locally), log with replay.
2. RabbitMQ with durable queues, publisher confirms, consumer acks, dead-letter queues.
3. Direct HTTP calls between services.

## Decision outcome

Option 2.

- **Outbox.** A service writes the event row in the same transaction as the business change. A relay publishes it with publisher confirms and marks it sent. A crash after commit and before publish resends on restart.
- **Inbox.** A consumer records `event_id` in the same transaction as the effect, under a unique constraint, then acks. A redelivery finds the id and acks without applying.
- **Envelope.** `{event_id, type, version, tenant_id, occurred_at, correlation_id, causation_id, payload}`, schema in `packages/contracts` (zod), versioned.
- **Failure path.** Poison messages go to a dead-letter queue with an alert and a replay command. A consumer acks only after its effect is committed.
- Redis (append-only file persistence on) holds caches, rate-limit counters and the websocket journal. It is not a source of truth for money or identity.

### Consequences

Good: simple semantics the owner asked for; operational cost is low; effects are exactly once even though delivery is not.

Bad: no log to replay a new consumer from history (we accept that, since history lives in each service's tables and outbox); ordering holds only per queue and is not guaranteed across services (see ADR 0006 on out-of-order events); each service needs a relay and a sweeper, and a relay outage delays everything downstream.

## Pros and cons of the options

- Option 1: replay and retroactive rules are attractive for analytics and missions, but heavier to run and not what the owner asked for. Revisit if missions need history replay.
- Option 3: no broker to run, but a caller must handle a callee being down, and nothing guarantees delivery after a crash.

## Built vs designed

- Built: outbox, inbox, dead-letter queue, publisher confirms.
- Designed only: a history-replay consumer; broker clustering.
