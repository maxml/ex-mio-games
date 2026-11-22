---
id: MIO-134
title: "Embedding: launch the widget from a casino page with a launch token, proven across two origins"
epic: EPIC-13
priority: P0
money_impact: direct
risk_class: identity
status: todo
depends_on: [MIO-044, MIO-130, MIO-135]
size: M
estimate_hours_base: 24
estimate_hours: 29
---

## Goal

A casino adds the widget to its site with a few lines, and the player's session, requests and messages
work and stay safe when the casino page and the widget are on different origins.

## Scope

- The embedding path chosen in MIO-135 (iframe or SDK), started with the casino's signed launch token.
- Allowed parent origins configured per tenant (`frame-ancestors` for an iframe, CORS allow-list for an
  SDK); `postMessage` with an exact `targetOrigin` and origin checks on receive.
- Simulator pages for Casino A and Casino B embed the widget on their own origins.

## Acceptance criteria

Two-origin browser acceptance test (Playwright, Chromium, Firefox and WebKit, third-party cookies
blocked): the casino simulator page is served from one origin (for example `casino-a.localhost`), the
widget from another (`widget.localhost`).

- **Launch and session:** the simulator page launches the widget with a launch token; the player sees the
  balance, spins and redeems; every API call is authenticated; no step relies on a third-party cookie
  unless MIO-135 chose a partitioned cookie, in which case the test asserts the cookie is partitioned.
- **Expiry:** an expired session inside the widget asks the casino page for a fresh launch through
  `postMessage` and continues without a reload of the casino page.
- **CSRF:** a state-changing request forged from a third origin (`evil.localhost`) is rejected; if the
  session uses no cookie, the test shows the request carries no ambient credential and fails with 401.
- **postMessage:** a message from an origin not on the tenant's list is ignored (no state change, no
  reply); the widget never posts with `targetOrigin = "*"` (unit test on the messaging module and a check
  in the browser test).
- **Framing:** embedding from an origin not on the tenant's list is blocked by the browser.
- `docs/integrations/embedding.md` shows the snippet, the token format and the allowed-origin settings.
