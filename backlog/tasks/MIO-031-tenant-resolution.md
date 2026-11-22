---
id: MIO-031
title: Tenant resolution from domain or casino launch token only
epic: EPIC-04
priority: P0
money_impact: enabler
risk_class: isolation
status: todo
depends_on: [MIO-030]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

The tenant of a request comes from something the client cannot forge.

## Scope

- Staff requests: tenant from the request host (subdomain or registered domain), then pinned in the
  session token's `tid` claim.
- Player requests: tenant from the signed casino launch token, then pinned in the session.
- Casino webhooks: tenant from the integration key that signed the request.
- Never from a body field, query string, `Referer` or a custom header.

## Acceptance criteria

- A request whose URL or body names tenant B, with a token for tenant A, is served as tenant A or rejected,
  never as tenant B.
- A request without a resolvable tenant is rejected with 400 (no default tenant).
- A request with no `Referer` behaves exactly like one with a `Referer`.
