---
id: MIO-040
title: Identity service with `IdentityProvider` interface and Firebase Auth Emulator adapter
epic: EPIC-05
priority: P0
money_impact: enabler
risk_class: identity
status: todo
depends_on: [MIO-001]
blocked_by: ["starter: identity service"]
size: L
---

## Goal

One service for authentication and authorization, with the external provider swappable behind an interface.

## Scope

- `IdentityProvider` port: `createTenant`, `createUser`, `verifyCredentials`, `exchangeLaunchToken`,
  `revokeSessions`, `deleteUser`.
- `firebase-emulator` adapter used by default (Firebase Auth Emulator in compose, demo project, no login).
- `fake` in-memory adapter for unit tests.
- Provider tenant provisioning is a fallible call, modelled as an outbox step with retries, not a plain insert.

## Acceptance criteria

- The same contract test suite passes against `fake` and `firebase-emulator`.
- No type or id from the provider SDK appears outside the identity service (lint rule on imports plus a
  test on the public contracts).
- A clean clone signs up and signs in an operator admin with no Google account configured.

## Notes

The emulator does not check custom-token signatures or expiry. Our launch-token verifier (MIO-044) must
check them before calling the provider, or a missing check would be hidden locally.
