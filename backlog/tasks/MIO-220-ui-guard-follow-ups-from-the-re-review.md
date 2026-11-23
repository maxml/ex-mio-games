---
id: MIO-220
title: UI guard follow-ups from the re-review
epic: EPIC-13
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: []
size: S
estimate_hours_base: 4
estimate_hours: 5
---

## Goal

The small gaps the re-review of the operator UI rework fix round left open are closed: a view test for the
Resolve preview, a live region that says something useful, preview tests that use the actions, and
screenshots that show what their captions say.

## Scope

- UIRR-2: the Resolve preview has no view test, except the guard added in 3b592ac.
- UIRR-5: the per-item store "Pending" live region covers only the request. While the POST is in flight it
  says "Pending", then goes blank; the real status lives in "Your redemptions". The store tab has five extra
  live regions.
- The `operator-ia` A-PREV-1 tests never use the preview actions. The reviewer's test is the only one that
  uses an action.
- Screenshots: `operator-ia-admin-landing.png` and `operator-ia-admin-setup.png` are byte-identical, so the
  README's two captions describe one picture. In the 208 px nav, some "Read-only" and "Preview" badges wrap
  under their entry (RoleNav, T1).

## Acceptance criteria

- A view test for the Resolve preview in `apps/web` is part of the suite, and a fetch added to `onResolve`
  turns it red.
- The `operator-ia` A-PREV-1 tests use every preview action.
- The store "Pending" live region is decided and tested: it covers the outcome, or it is removed.
- The admin landing and setup screenshots differ, or the two captions are merged into one.
- The Read-only and Preview badges do not wrap under their nav entry.

## Notes

Findings UIRR-2 and UIRR-5 of the re-review. UIRR-5 had no test (judgement). The badge wrap is cosmetic and
older than the fix round. A re-run rewrote `operator-ia-admin-redemptions.png` with a different hash, so the
screenshots are not pixel-stable, and a `git diff --exit-code` check on them would be flaky.
