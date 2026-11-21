---
id: MIO-182
title: Part E answers (`docs/scaling.md`)
epic: EPIC-17
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-010, MIO-070, MIO-057]
size: M
---

## Goal

Answer the Part E questions briefly and concretely.

## Scope

1. From prototype to production-ready multi-tenant SaaS: what changes (managed Postgres with backups and
   point-in-time recovery, broker clustering, secrets handling, identity provider decision, RNG
   certification, data residency, on-call, SLOs), in order of risk.
2. Ten casino operators without ten codebases: one codebase, adapters per casino platform (not per
   operator), configuration per tenant, the shared adapter contract suite (MIO-057).
3. PvP, Missions, Kingdom Builder without coupling to the integration layer: canonical events only (MIO-070).
4. First 90 days: link to MIO-183.
5. Smallest realistic team for an MVP in six months, with roles and why each is needed.
6. What we would automate with AI: spec and test drafting, review with mutation evidence, adapter
   scaffolding from a casino's API docs, sample generation, release notes, triage of DLQ messages.

## Acceptance criteria

- Each of the six questions has its own section with a direct answer in the first sentence.
- Every claim about the current system links to code, a test or an ADR.
