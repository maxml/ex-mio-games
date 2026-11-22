---
id: EPIC-10
title: Product analytics through Varta
priority: P0
status: todo
---

# EPIC-10 Product analytics through Varta

## Goal

Product analytics from day one, because without data we cannot decide. All analytics go through Varta
(our observability and analytics project) and end up in one panel. The product emits events as
structured log lines under Varta's telemetry contract; it has no runtime dependency on Varta.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-100 | Event taxonomy v1 (one-way door) | P0 |
| MIO-101 | Analytics emitter under the Varta contract, with an honest delivery guarantee | P0 |
| MIO-102 | Operator funnel instrumentation | P0 |
| MIO-103 | Player funnel instrumentation | P0 |
| MIO-104 | Billing events: subscription changes and daily MRR snapshot | P1 |
| MIO-105 | Frontend event relay `POST /v1/events` | P1 |
| MIO-106 | One analytics panel in Varta, with a reader test | P1 |
| MIO-107 | Privacy: PII rules, consent, delete-by-actor runbook | P1 |
| MIO-108 | Experiment exposure event | P3 |
| MIO-199 | Product events take the environment from one source, not a required field nobody reads | P2 |

## One-way doors

Event names, `tenant_id` format, pseudonymous `actor_id` scheme, `event_id` (UUIDv7). Changing them later
breaks every historical chart.
