---
id: MIO-124
title: Move prototype elements into Storybook
epic: EPIC-12
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-121, MIO-123]
size: M
---

## Goal

The prototype's elements become the product's components; nothing is designed twice.

## Scope

Move each reusable element from `design/prototype/` into `packages/ui` with stories; the prototype then
imports from `packages/ui`.

## Acceptance criteria

- After the move, `design/prototype/` contains only screens and mock data, no component definitions
  (check by script).
- Visual snapshots of the prototype screens before and after the move match.

## Carried over from the prototype review (round 3, `design-prototype` b0e2878)

These were deferred when the prototype merged; close them during the move:

- The legacy `invoice/pay` action can still mark an invoice paid while a payment attempt is in flight. No
  screen dispatches it, only tests: remove it or route it through the payment attempt.
- Native checkboxes: replace them with a shared Checkbox component.
- `tokens.css` defaults are not validated against the token schema; tenant JSON is.
- Wheel labels during a spin were checked only in unit tests, not in a browser.
- No screen-reader pass has been done yet.
