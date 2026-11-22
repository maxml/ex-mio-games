---
id: MIO-198
title: Behaviour test that the internal balance read refuses a request without an environment
epic: EPIC-08
priority: P1
money_impact: none
risk_class: guard
status: todo
depends_on: [MIO-083, MIO-086]
size: S
estimate_hours_base: 3
estimate_hours: 4
---

## Goal

The internal balance read of the payments service cannot silently default to production. Today only a
static scan pins this; no test sends the request.

## Scope

- A behaviour test at the controller of `GET /internal/v1/players/:playerId/balance` (service token).
- The query parameter `sandbox` stays required (`true` or `false`), with no default.

## Acceptance criteria

- A service-token request without `sandbox` answers 400 with the validation error code, and the balance
  service is not called.
- A request with `sandbox=banana` answers 400; `sandbox=true` and `sandbox=false` call the read with the
  matching environment.
- Mutation: change the query schema to `.default('false')`. The new test goes red (the static scan alone is
  not accepted as the proof).
- The same request with a user token (not a service token) is still refused.

## Notes

Source: the re-review of the fix round (finding R7: the behaviour has only a static scan, and under the
mutation the payments unit suite stayed green except one test that a different mutation turned red).
