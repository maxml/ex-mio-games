---
id: MIO-204
title: CI proven on the default stack slot with the tagged images
epic: EPIC-01
priority: P1
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-003, MIO-006]
size: S
estimate_hours_base: 6
estimate_hours: 8
---

## Goal

The CI stack job works with the slot scripts and image tags that local development now uses. It was never
run on the default slot 0 and never run on a CI runner.

## Scope

- Run the CI `stack` job (compose up with a build, compose tests, demo) on a runner and fix what breaks.
- Make sure the job uses slot 0 defaults, the image tags the build step produces, and cleans up with
  `down -v`.

## Acceptance criteria

- One green run of the `stack` job on a clean runner, linked from the README; the run log shows the images
  built once and the health test passing.
- A second run of the job on the same commit builds no image (the tag exists) and is green.
- After the job, no container, volume or network of the project remains (the cleanup step prints empty
  lists).
- Starting a local slot 1 stack while another is up does not change the CI behaviour (the job uses slot 0
  only).

## Notes

Source: the stack slots handoff (CI was not run; slot 0 was not exercised).
