---
id: MIO-217
title: Health endpoint reports the build SHA
epic: EPIC-15
priority: P2
money_impact: none
risk_class: none
status: todo
depends_on: [MIO-162]
size: S
estimate_hours_base: 3
estimate_hours: 4
---

## Goal

An operator can tell which release a running service is from. `/health` reports the package.json version
(`0.1.0`) today, which is the same for every build.

## Scope

- Pass the build SHA into each service image at build time and return it from `/health` next to the version.
- Show the same value in the deploy output so a deployment and the running service can be compared.

## Acceptance criteria

- `/health` of every service returns the build SHA of the image it runs.
- A test builds with a known SHA and reads it back from `/health`; without a SHA the field is `unknown`,
  not an empty string.

## Notes

Found on the pre-production deployment of release `8533c10`, where the running version could not be told
apart from an older build.
