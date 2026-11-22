---
id: MIO-044
title: 'Player identity mapping: casino launch token to player session'
epic: EPIC-05
priority: P0
money_impact: direct
risk_class: identity
status: todo
depends_on: [MIO-042, MIO-050, MIO-135]
size: L
estimate_hours_base: 32
estimate_hours: 39
---

## Goal

A casino player opens the widget and is recognised as the same player whose deposits the casino reports,
and nobody can become another player by changing a token or a request field.

## Scope

- **Mapping contract.** `player_links (tenant_id, platform, external_player_id) → user_id` with
  `UNIQUE (tenant_id, platform, external_player_id)` and `UNIQUE (tenant_id, user_id)`: one external
  player maps to exactly one user in a tenant, and one user has exactly one link. `platform` is the
  casino platform type registered for the tenant.
- **One writer.** Identity owns `player_links` and is the only service that creates links, through
  `resolveOrCreatePlayer(tenant, platform, externalPlayerId)` (service-to-service, idempotent).
  Engagement calls it on the first deposit and on launch; it never writes its own mapping and keeps no
  second copy other than a read-only cache of `user_id` keyed by the same triple.
- **Launch token.** The casino signs a launch token with its per-tenant key, carrying the external player
  id, `aud`, `exp` (at most 5 minutes), `iat` and a unique `jti`. Identity verifies algorithm (fixed
  allow-list), signature, expiry, audience and tenant **before** any provider call, records the `jti`
  (single use), resolves the link, and issues our session in the form chosen by MIO-135.
- The tenant comes only from the key that verified the token, never from a claim or a request field.

## Acceptance criteria

- Launch token rejected, with no session and no link row, when: the signature is bad; `alg` is `none` or
  not on the allow-list; it is signed with another tenant's key; it is expired or `iat` is in the future;
  `aud` is wrong; the `jti` was already used (replay); the external player id was changed after signing.
- Deposit arrives before the first launch: the later launch maps to the same `user_id` and sees the spin.
- The same external player id in two tenants maps to two different `user_id`s; the same external player
  id on two platforms of one tenant maps to two different `user_id`s.
- Concurrent first launches and a concurrent first deposit for one external id create exactly one link row.
- A request that names a `user_id` or an external player id in its body or query (spin, redemption,
  balance, history) is rejected by validation; the acting player always comes from the session.
- Reader test: the link written on first deposit is the one resolved on launch (same `user_id`), and the
  operator's player lookup shows the external id and our id correctly.
- Mutation: remove the `jti` single-use check (the replay test goes red); resolve the tenant from a token
  claim instead of the verifying key (the other-tenant-key test goes red).

## Notes

Assignment Part A: player identity mapping. Same-tenant hostile-player tests are in MIO-154.
