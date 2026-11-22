---
id: MIO-212
title: Plain http for a reward API needs an explicit non-production setting, not an absent one
epic: EPIC-06
priority: P2
money_impact: none
risk_class: guard
status: todo
depends_on: [MIO-050]
size: S
estimate_hours_base: 3
estimate_hours: 4
---

## Goal

A hand-run deployment that forgets `NODE_ENV` does not accept `http` reward API URLs.

## Scope

- The shared URL rule allows `http` only when `NODE_ENV` is one of an explicit list (`development`, `test`).
  An absent value or any other value means https only.
- Identity and engagement use the same function, so they cannot disagree.

## Acceptance criteria

- With `NODE_ENV` unset, an `http://` reward API URL is refused in both services with the https error.
- With `NODE_ENV=production` or an unknown value (`staging`), `http` is refused; with `development` and
  `test`, `http` is accepted.
- The compose stack and the unit suites that use http set an allowed value explicitly and stay green.
- Mutation: treat an absent value as non-production again. The unset case goes red.

## Notes

Source: the second re-review of the fix round (finding F6: fail-open only for a hand-run deployment,
because the images set `NODE_ENV=production`).
