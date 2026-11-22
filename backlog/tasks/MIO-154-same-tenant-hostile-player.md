---
id: MIO-154
title: "Part C: same-tenant hostile player cannot touch another player's spins, coins or rewards"
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: ownership
status: todo
depends_on: [MIO-044, MIO-063, MIO-066, MIO-067, MIO-083, MIO-085, MIO-092]
size: M
estimate_hours_base: 24
estimate_hours: 29
---

## Goal

Cross-tenant tests do not prove ownership inside one casino. Prove that player A of a tenant cannot
spend, read or redeem anything that belongs to player B of the same tenant, through any route.

## Scope

- Ownership is checked at the repository and command boundary: every player-facing query and command is
  scoped by `(tenant_id, user_id)` taken from the session, and the object lookup includes `user_id`
  (`WHERE tenant_id = $1 AND user_id = $2 AND id = $3`). Controllers do not do their own ownership check
  as the only check.
- Fixture: one tenant, two players A and B with spins, coins, a pending redemption and a completed one.

## Acceptance criteria

All requests below are made with player A's valid session in the same tenant as B.

- Spin with B's spin credit id: 404; B's credit stays available; no spin row for A.
- Read B's spin result by id: 404.
- Read B's balance (`/v1/players/{B}/balance`, or any balance route with B's id): 403 or 404; A's own
  balance route ignores any user id in the query.
- Read B's coin history: 404.
- Read B's redemption by id, list redemptions filtered by B's id, or cancel or replay B's redemption: 404.
- Redeem with a body naming B (`user_id`, `player_id`, `external_player_id`): 422 by validation; nothing
  is held from B's balance.
- Replay B's idempotency key with A's session: treated as A's own new operation (MIO-086), never returns
  B's stored response.
- Subscribe to B's websocket channel: refused (once MIO-110 exists; until then the test is marked pending
  with the task id).
- A launch token for B's external id signed by the casino gives B's session, not A's; A cannot exchange
  A's session for B's by sending B's external id anywhere.
- Sandbox and production inside one tenant (MIO-092): a sandbox player's session cannot read or spend a
  production player's spins, coins or redemptions, and the reverse; a sandbox launch token never maps to
  a production player.
- An operator analyst of the same tenant can read B's balance and history (allowed) but cannot spin or
  redeem for B (403).
- Mutations the reviewer re-applies: drop `user_id` from the spin-credit consume query (the first test goes
  red); drop `user_id` from the redemption lookup (the redemption read test goes red); take the user from
  the body instead of the session (the redeem test goes red).
