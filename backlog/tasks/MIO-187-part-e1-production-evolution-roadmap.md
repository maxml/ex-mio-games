---
id: MIO-187
title: 'Part E1: from prototype to production-ready multi-tenant SaaS, with the production roadmap'
epic: EPIC-17
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-010, MIO-016, MIO-186]
size: M
---

## Goal

Answer Part E question 1 with milestones a team can execute, and say plainly what production needs that
the assignment demo does not have, why it is deferred, who owns it and how we will know it is done.

## Scope

Section 1 of `docs/scaling.md`:

- **Milestones**, in order of risk: pilot (one paying operator), production readiness, scale-out. For each:
  entry criteria, exit criteria with numbers, and the migration strategy from the previous milestone
  (data migrations expand then contract; zero-downtime deploys; feature flags per tenant).
- **Operational readiness:** SLOs per user journey (deposit to spin, redemption to final status), alerts
  tied to them, on-call ownership, runbooks for DLQ replay and `NEEDS_REVIEW` redemptions.
- **Production roadmap table.** One row per item; columns: what exists in the demo, what production
  needs, why it is deferred, owner (role), how completion is measured.
  - Tenant onboarding and suspension (self-serve exists; suspension on non-payment exists; production
    adds KYB checks, contract limits, data export on exit).
  - Credential rotation (integration keys, webhook secrets, signing keys, database credentials): the
    rotation procedure, its frequency, and a drill that proves rotation without downtime.
  - Privacy retention and redaction: retention period per data class, deletion and anonymisation
    (MIO-107), log redaction (MIO-160), and the evidence a regulator would ask for.
  - Backup, restore and reconciliation: point-in-time recovery per service database, a restore drill
    with a measured recovery time, and reconciliation after restore (MIO-084) before traffic resumes.
  - Failure ownership: who owns each failure class (casino unreachable, payments down, broker down,
    reconciliation mismatch, provider webhook backlog), the alert, and the first action.
  - RNG certification, data residency, identity provider decision (MIO-041).

## Acceptance criteria

- The first sentence answers the question directly.
- Every roadmap row has all five columns filled; "owner" is a role, "how measured" is a number or a
  pass/fail drill.
- Every claim about the current system links to code, a test or an ADR.
