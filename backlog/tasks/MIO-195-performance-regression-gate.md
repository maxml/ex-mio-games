---
id: MIO-195
title: Performance regression gate in CI, smoke on every main merge and a full nightly run
epic: EPIC-18
priority: P1
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-006, MIO-193, MIO-194]
size: M
estimate_hours_base: 12
estimate_hours: 15
---

## Goal

A change that makes a money path slower fails the build before release, without a person remembering to
run a load test.

## Scope

- **Smoke-load job** on every merge to `main`: about two minutes against the compose stack, a reduced
  version of each scenario of MIO-194 at about 20 percent of the budget rate, with thresholds from
  `tests/perf/thresholds.json`.
- **Full run** nightly and before a release tag: all scenarios at full rate (soak is MIO-197).
- Thresholds have two parts: the absolute SLO from MIO-193, and a relative check against the last
  accepted baseline (default tolerance 25 percent on p95) so a slow drift fails before the absolute line.
- Results are stored as a build artifact; a trend page or file shows p95 per scenario over the last 30
  runs. The baseline moves only through a reviewed commit that updates the committed report.
- Failure output names the scenario, the metric, the threshold and the measured value.

## Acceptance criteria

- A merge to `main` runs the smoke job and its status is visible next to `ci-ok`.
- A deliberate 300 ms sleep added to the spin handler turns the smoke job red (negative test run once and
  recorded in the pull request).
- A change that only touches docs does not run the smoke job (path filter), and a change under
  `apps/` or `packages/` does.
- The nightly job runs all four scenarios and publishes the report as an artifact; a missed night raises
  an alert (the absence of a run is a failure, as in MIO-164).
- The smoke job finishes in under 6 minutes including stack start-up.
- The job has no secrets and no network access beyond the compose network, as in MIO-003.

## Notes

Shared CI runners are noisy, so the smoke job uses the relative check with a fixed tolerance and one
automatic re-run before it fails; the nightly run on the same runner class is the reference. The gate does
not run on every pull request, only on `main` merges, to keep pull request feedback fast.
