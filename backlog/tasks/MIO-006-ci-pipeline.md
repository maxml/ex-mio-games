---
id: MIO-006
title: "CI pipeline: lint, typecheck, test, build on affected projects"
epic: EPIC-01
priority: P1
money_impact: enabler
risk_class: none
status: todo
depends_on: [MIO-001]
blocked_by: ["starter: CI presets"]
size: S
estimate_hours_base: 8
estimate_hours: 10
---

## Goal

Every pull request is checked automatically and fast.

## Scope

- One always-running required job (`ci-ok`) on pull requests and the merge queue.
- `nx affected -t lint typecheck test build`, frozen lockfile, read-only token permissions.
- Postgres, Redis and RabbitMQ as service containers for integration tests.
- Actions pinned to commit SHAs, dependency review, no `pull_request_target`.
- Mutation testing (Stryker) on the payments and engagement money paths, reported per pull request.

## Acceptance criteria

- A pull request with a failing unit test cannot be merged.
- A pull request that touches only `web` does not run payments integration tests.
- The workflow file passes an actions linter with no warnings.
