---
id: EPIC-06
title: Casino integrations module and event ingestion
priority: P0
status: todo
---

# EPIC-06 Casino integrations module and event ingestion

## Goal

Casino platforms with different event schemas and reward APIs plug in through adapters. Inside, there is
one canonical model, so the gamification logic is the same for every casino. The integrations code is a
module inside the engagement service, not a separate service.

## Tasks

| ID      | Title                                                                                | Priority |
| ------- | ------------------------------------------------------------------------------------ | -------- |
| MIO-050 | Canonical event model and adapter interface, with the recovery contract              | P0       |
| MIO-051 | Casino A: simulator and adapter                                                      | P0       |
| MIO-052 | Casino B: simulator and adapter with a different schema and reward API               | P1       |
| MIO-053 | Simulator fault injection                                                            | P1       |
| MIO-054 | Webhook ingestion: signature, timestamp window, per-tenant secret, schema validation | P0       |
| MIO-055 | Event deduplication in the same transaction as the effect                            | P0       |
| MIO-056 | `DepositConfirmed` published through the outbox to RabbitMQ                          | P0       |
| MIO-057 | Shared adapter contract test suite (written before the first adapter)                | P0       |

## Covers

Assignment Part A (integration layer, event ingestion, validation, deduplication), Part B steps 1, 2, 7
and the two-casino requirement, Part E question 2.
