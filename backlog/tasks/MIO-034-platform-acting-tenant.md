---
id: MIO-034
title: Platform admin acts in an operator tenant only through explicit, audited `acting_tenant`
epic: EPIC-04
priority: P1
money_impact: enabler
risk_class: ownership
status: todo
depends_on: [MIO-032, MIO-045, MIO-161]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

MIO staff can support an operator without a hidden "sees everything" mode.

## Scope

- Platform staff request a short-lived `acting_tenant` session for one operator tenant, with a reason.
- Every action in that session is written to the audit log with the real actor and the acting tenant.
- There is no "tenant is null means all tenants" shortcut anywhere.

## Acceptance criteria

- A platform admin token without `acting_tenant` gets 403 on operator-tenant endpoints.
- Each request made with `acting_tenant` creates one audit entry naming both identities; the reader test
  shows that entry in the operator's audit view, described correctly.
- An operator admin cannot obtain `acting_tenant` for any tenant.
- Negative cases, each its own test:
  - an acting session for tenant A used on a URL, body or header naming tenant B: 403, the URL value never
    overrides the session's acting tenant;
  - an expired acting session: 401, no action;
  - a request for an acting session without a reason: 400;
  - an operator token with a forged `acting_tenant` claim (signed by an unknown key or added to a valid
    token without re-signing): 401;
  - an acting session cannot call coin commands that move value (`credit`, `hold`, `capture`, `release`,
    `refund`) except the audited adjustment path; it cannot create another acting session.
- Mutation: let a path tenant override the acting tenant, then the first negative test goes red.
