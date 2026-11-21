---
id: EPIC-05
title: Identity (authentication and authorization)
priority: P0
status: todo
---

# EPIC-05 Identity

## Goal

One identity service handles authentication and authorization for operator staff, platform staff and
players. The external identity provider sits behind an `IdentityProvider` interface so it can be
replaced quickly. Locally the Firebase Auth Emulator is used, so a clean clone needs no accounts.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-040 | Identity service with `IdentityProvider` interface and Firebase Auth Emulator adapter | P0 |
| MIO-041 | Identity provider choice: Firebase Identity Platform or AWS Cognito | P2 |
| MIO-042 | Own user ids and own tokens (JWT + JWKS) | P0 |
| MIO-043 | Operator staff sign-up and sign-in, email unique per tenant | P0 |
| MIO-044 | Player identity mapping: casino launch token to player session | P0 |
| MIO-045 | Roles and permissions (`can(subject, action, object)`) in our database | P1 |
| MIO-046 | Service-to-service authentication | P1 |

## One-way doors

Our own `user_id` and `tenant_id`, our own JWT, roles in our DB, the launch-token port, email unique per
tenant. Provider ids never leave the identity service.
