---
id: MIO-045
title: Roles and permissions (`can(subject, action, object)`) in our database
epic: EPIC-05
priority: P0
money_impact: enabler
risk_class: ownership
status: todo
depends_on: [MIO-042]
size: M
---

## Goal

Every protected action asks one function whether it is allowed.

## Scope

- Roles: platform `admin`, `support`; operator `owner`, `admin`, `analyst`; `player`.
- `can(subject, action, object)` checks role and ownership (`object.tenant_id`, `object.user_id`).
- Roles stored in the identity DB, never in provider claims.
- Decorator for controllers; default deny for routes without a permission declared.

## Acceptance criteria

- A test walks all routes and fails if any route has no permission declared.
- An operator `analyst` cannot change rules or wheel tables (403).
- A player cannot read another player's redemption (404, not 403, to avoid confirming existence).
