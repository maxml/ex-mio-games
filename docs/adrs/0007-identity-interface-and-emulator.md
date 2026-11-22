# 0007. Identity behind an interface, local emulator now, provider choice deferred

- Status: accepted (the production provider choice is explicitly open)
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: high for the interface, low for the eventual provider

## Context and problem statement

The product needs authentication and authorization for players, casino staff and platform admins, in many tenants, plus a way for a casino page to launch a player into the widget. Choosing a production identity provider (Firebase Identity Platform or AWS Cognito) depends on facts we do not have yet: data residency, price per active user, casino launch-token flow. A clean clone must run with no cloud accounts.

## Decision drivers

- Owner: Firebase behind an interface so it can be replaced by Cognito quickly; local Firebase Auth Emulator now; choice deferred.
- Clean clone, no accounts, no network egress to a provider.
- The provider verifies identity; our service owns tenants, roles and the token our other services trust.

## Considered options

1. Bind directly to one provider's SDK.
2. An `IdentityProvider` interface with an emulator-backed implementation now.
3. Own the full credential store and password handling.

## Decision outcome

Option 2.

- `identity` is the single service for authN and authZ. It defines `IdentityProvider` (create provider tenant, create user, verify credentials, revoke sessions, delete user) and ships one implementation against the Firebase Auth Emulator, which supports tenants and per-tenant users (one provider tenant per MIO tenant). A second, `fake`, implementation is for tests and is refused in production.
- **Players do not use the provider.** A player is identified only by the casino launch token; identity issues our own player JWT. Only staff and operators have provider accounts.
- `identity` exchanges a verified provider credential or a signed, single-use casino launch token for its own short-lived JWT (15 minutes, no refresh token), published through JWKS. Other services verify that JWT locally and take the tenant only from the verified `tid` claim.
- Authorization is role-based (a permission guard on each route) and tenant-scoped.
- The mapping `(tenant, platform, external_player_id) -> user_id` is owned by `identity`, which is the only writer (`resolveOrCreatePlayer`).
- Personal data lives only in `identity`. Other services hold opaque ids (supports erasure without editing ledger, audit or analytics rows).
- Provider-specific concepts must not leak past the interface. One-way doors to check before the production choice: how a launch token is minted, custom claim size limits, tenant model, data location.

### Consequences

Good: a fast local start, no vendor lock in code, the comparison can be finished later with real numbers.

Bad: the emulator is not the production provider, so behaviours that differ (rate limits, email delivery, token claims size) are untested until the adapter exists. A real pilot needs a production adapter, a deployment security review and a restore drill.

## Built vs designed

- Built: the interface, the emulator implementation, JWT and JWKS, RBAC, launch-token exchange, the identity mapping.
- Next: the production provider adapter (Firebase Identity Platform or Cognito; the choice is not made), password import, social login, refresh tokens.
