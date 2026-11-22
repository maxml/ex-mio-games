---
id: MIO-135
title: "Decision: how the widget lives inside a casino site (iframe or signed-token SDK) and how its session works"
epic: EPIC-13
priority: P0
money_impact: direct
risk_class: identity
status: todo
depends_on: []
size: M
---

## Goal

Decide, before identity and web tasks build on it, how the player widget is embedded in a casino page
and how the player's session works there. The casino site and our widget are on different origins, and
browsers block or partition third-party cookies, so a same-origin cookie session does not prove anything
about the embedded case.

## Scope

- Options to compare, each with a short spike that runs in the current Chrome, Firefox and Safari with
  third-party cookies blocked:
  1. iframe on our origin; the launch token is exchanged for a short-lived access token held in memory
     inside the iframe (no cookie needed), refreshed by re-launch through the casino page;
  2. iframe on our origin with a partitioned cookie (`SameSite=None; Secure; Partitioned`);
  3. a script SDK that renders in the casino page and calls our API with a bearer token from the launch
     exchange (no cookies, CORS allow-list per tenant).
- For the chosen option, the ADR fixes: the session carrier and its lifetime; CSRF protection (not needed
  for pure bearer tokens, required for any cookie); the `postMessage` protocol (message types, the exact
  `targetOrigin`, origin checks on receive); the per-tenant allowed-origin list (`frame-ancestors` or
  CORS); what happens when the token expires mid-session.
- The operator and platform consoles are first-party (top-level on our origin) and keep the BFF cookie
  session (MIO-133); this decision is about the player widget only.

## Acceptance criteria

- ADR in `docs/adrs/` "Widget embedding and player session" with the comparison, the choice and the reasons.
- The spike for the chosen option passes a two-origin browser test (Playwright, casino page on one origin,
  widget on another, third-party cookies blocked in all three engines): launch, session established,
  one authenticated API call succeeds.
- The ADR lists, for each consumer of the decision (player mapping, widget, console sessions, embedding,
  websocket), what it must and must not assume.

## Notes

Consumers: MIO-044, MIO-130, MIO-133, MIO-134 and MIO-110 depend on this task; none of them assumes a
cookie in the embedded context unless the ADR chose option 2.

This replaces the earlier assumption that the iframe would use the same SameSite cookie as the consoles.
