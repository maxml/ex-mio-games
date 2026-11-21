---
id: MIO-042
title: Own user ids and own tokens (JWT + JWKS)
epic: EPIC-05
priority: P0
money_impact: enabler
risk_class: identity
status: todo
depends_on: [MIO-040]
size: M
---

## Goal

Other services trust only our tokens and our ids, so the provider can change without touching them.

## Scope

- Identity issues short-lived access JWTs (claims: `sub` = our `user_id`, `tid` = `tenant_id`, `roles`,
  `aud` per service) and rotating refresh tokens.
- Public keys at `/.well-known/jwks.json`; services verify with `jose` and cache the key set.
- Mapping table `(tenant_id, user_id) ↔ (provider, provider_tenant, provider_subject)`.

## Acceptance criteria

- A token signed by an unknown key is rejected by every service.
- A token whose `aud` is `payments` is rejected by `engagement`.
- An expired access token is rejected; a reused refresh token revokes the whole token family.
- Rotating the signing key does not log out users with tokens signed by the previous key until they expire.
