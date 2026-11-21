---
id: MIO-133
title: BFF with HttpOnly cookie sessions
epic: EPIC-13
priority: P0
money_impact: enabler
risk_class: identity
status: todo
depends_on: [MIO-042]
size: M
---

## Goal

Tokens never reach browser JavaScript.

## Scope

- The web app's server side holds access and refresh tokens; the browser gets an HttpOnly, Secure,
  SameSite cookie.
- CSRF protection on state-changing requests; the BFF forwards calls to services with the user's token.

## Acceptance criteria

- No token is readable from `document.cookie` or local storage (end-to-end test).
- A cross-site POST without the CSRF token is rejected.
- Logout revokes the refresh token on the identity service.
