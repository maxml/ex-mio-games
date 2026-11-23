---
id: MIO-219
title: The Spin button keeps keyboard focus
epic: EPIC-13
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: []
size: S
estimate_hours_base: 3
estimate_hours: 4
---

## Goal

A keyboard or screen-reader user does not lose their place when a spin starts, and can reach the "No spins
left" button at 0 spins. SpinPanel sets the native `disabled` attribute on Spin, so in Chromium focus drops
to `<body>` after Enter and the button leaves the Tab order. Button's own comment says a busy button stays
focusable so keyboard focus is not thrown to `<body>`.

## Scope

- In `packages/ui/src/SpinPanel.tsx`, keep the button focusable: `aria-disabled="true"` and ignore the
  click, the way Button handles `loading`.
- In the same change, the UIR-4 test turns `toBeDisabled()` into `toHaveAttribute('aria-disabled', 'true')`.
  Its `onSpin`-once checks stay.

## Acceptance criteria

- The three `it.fails` cases in `packages/ui/src/ui-rework-rereview.review.test.tsx` (locked after the first
  click, busy, 0 spins; red tests from commit 3b592ac) pass as plain `it`.
- Focus stays on the Spin button after Enter, and at 0 spins "No spins left" is in the Tab order.
- The UIR-4 test checks `aria-disabled`, and a second click still calls `onSpin` only once.

## Notes

Finding UIRR-1 (major) of the re-review of the operator UI rework fix round. UIR-6 moved the regression
into the widget: before `ad0f099` the web Spin button used `aria-disabled` only. Related: WCAG 2.4.3 focus
order; spec section 6, "the player widget behaviour does not change".
