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
---

## Goal

MIO staff can support an operator without a hidden "sees everything" mode.

## Scope

- Platform staff request a short-lived `acting_tenant` session for one operator tenant, with a reason.
- Every action in that session is written to the audit log with the real actor and the acting tenant.
- There is no "tenant is null means all tenants" shortcut anywhere.

## Acceptance criteria

- A platform admin token without `acting_tenant` gets 403 on operator-tenant endpoints.
- Each request made with `acting_tenant` creates one audit entry naming both identities.
- An operator admin cannot obtain `acting_tenant` for any tenant.
