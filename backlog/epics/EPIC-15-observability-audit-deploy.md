---
id: EPIC-15
title: Observability, audit, security baseline, deploy
priority: P1
status: todo
---

# EPIC-15 Observability, audit, security baseline, deploy

## Goal

We can see what the system does (Varta), prove who did what (audit log), and deploy it (Deckhand) without
inventing anything new.

## Tasks

| ID      | Title                                                                      | Priority |
| ------- | -------------------------------------------------------------------------- | -------- |
| MIO-160 | Telemetry under the Varta contract: logs, traces, metrics, correlation ids | P1       |
| MIO-161 | Audit log for financial and admin actions                                  | P1       |
| MIO-162 | Health, readiness, timeouts, graceful shutdown                             | P1       |
| MIO-163 | Deckhand deploy manifest for all services                                  | P2       |
| MIO-164 | Alerts: DLQ not empty, reconciliation drift, issuance failure rate         | P2       |
| MIO-165 | Security baseline: SECURITY.md, dependency review, static analysis         | P2       |
| MIO-201 | Structured log and security metric for ordinary authorization refusals     | P1       |
