---
id: MIO-133
title: BFF with HttpOnly cookie sessions for the consoles
epic: EPIC-13
priority: P0
money_impact: enabler
risk_class: identity
status: todo
depends_on: [MIO-042, MIO-135]
size: M
---

## Goal

Tokens never reach browser JavaScript in the operator and platform consoles. The player widget's session
follows the embedding decision (MIO-135), because a casino page is a third-party context.

## Scope

- The web app's server side holds access and refresh tokens; the browser gets an HttpOnly, Secure,
  `SameSite=Lax` cookie on our first-party console origin.
- CSRF protection on state-changing requests; the BFF forwards calls to services with the user's token.
- The BFF caches the access token per session until shortly before expiry; it does not call identity on
  every request. Concurrent requests that need a refresh share one refresh call (single flight). A refresh
  that times out or fails returns 401 to the browser and never forwards a request without a token.

## Acceptance criteria

- No token is readable from `document.cookie` or local storage (end-to-end test).
- A cross-site POST without the CSRF token is rejected.
- Logout revokes the refresh token on the identity service.
- 20 parallel console requests with an expired access token cause exactly one refresh call to identity.
- Identity down: console requests fail with 401 or 503 within the configured timeout; no domain service
  receives an unauthenticated request.
