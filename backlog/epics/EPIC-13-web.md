---
id: EPIC-13
title: "Web applications: player widget, operator console, platform admin console"
priority: P0
status: todo
---

# EPIC-13 Web applications

## Goal

Three audiences, one web app built from Storybook components:

- the player widget, embedded in the casino site;
- the operator console, where operators onboard, pay and configure;
- the platform admin console, where MIO staff see tenants and revenue.

The assignment does not ask for a polished frontend. We build one anyway because design sells, but the
backend demo never depends on it.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-130 | Player widget: wheel, balance, store, reward status, history | P0 |
| MIO-131 | Operator console: onboarding, keys, rules, wheel tables, store, billing | P1 |
| MIO-132 | Platform admin console: tenants, revenue, usage | P1 |
| MIO-133 | BFF with HttpOnly cookie sessions for the consoles | P0 |
| MIO-134 | Embedding: launch the widget from a casino page with a launch token, proven across two origins | P0 |
| MIO-135 | Decision: widget embedding path (iframe or signed-token SDK) and its player session | P0 |
| MIO-202 | Service routes for the sandbox check and go-live, and the console switched to them | P1 |
| MIO-203 | Routes for coin history, cross-tenant admin tables and the usage chart, with the consoles live | P2 |
