---
id: MIO-201
title: Structured log and security metric for ordinary authorization refusals
epic: EPIC-15
priority: P1
money_impact: none
risk_class: guard
status: todo
depends_on: [MIO-046, MIO-160, MIO-161]
size: M
estimate_hours_base: 12
estimate_hours: 15
---

## Goal

A refused request (403 or 404 on a foreign object) leaves a trace an operator can search and a counter an
alert can watch. Today only acting requests and service calls are audited, so an ordinary refusal leaves
nothing.

## Scope

- One structured log line per refusal from the typed refusal error, with the route, the reason code, the
  tenant, the principal kind and the request id. No token, no body, no personal data.
- A counter `authorization_refused_total` labelled by service, reason code and principal kind, exposed
  through the telemetry package (MIO-160). Labels have a fixed small set of values.
- No audit-table row for these (the audit log stays for financial and admin actions, MIO-161).

## Acceptance criteria

- A request refused by each guard (role, tenant mismatch, foreign object, suspended tenant) writes exactly
  one log line with the fields above and increments the counter by one.
- The response body of the refusal is unchanged (same code and shape as before), so nothing leaks.
- A scan test finds no untyped 403 left in the services (each goes through the typed error).
- The log line holds no secret: a probe request with a token and a body shows neither in the output.
- Mutation: remove the log call in the interceptor. The log test goes red; remove the counter increment and
  the counter test goes red.

## Notes

Source: the re-review of the fix round (the structured log and security metric required by decision D-28
for ordinary refusals do not exist; reported in two rounds).
