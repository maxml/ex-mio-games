---
id: EPIC-07
title: "Engagement: rules, wheel, bonus store, redemption"
priority: P0
status: todo
---

# EPIC-07 Engagement

## Goal

The gamification core: a rules engine turns casino events into spins, the wheel gives a deterministic,
server-authoritative reward from a weighted table, and the Bonus Store lets players redeem coins for
rewards that the casino issues. Reward status is tracked and exposed through an API.

## Tasks

| ID | Title | Priority |
|---|---|---|
| MIO-060 | Rules engine: tenant-configured, versioned rules | P0 |
| MIO-061 | Spin credits granted from `DepositConfirmed`, once per event | P0 |
| MIO-062 | Weighted reward tables, versioned and validated | P0 |
| MIO-063 | Server-authoritative deterministic spin | P0 |
| MIO-064 | Coin reward from a spin recorded through payments | P0 |
| MIO-065 | Bonus Store catalog | P0 |
| MIO-066 | Redemption saga: hold, issue, capture or release, with a full state-transition table | P0 |
| MIO-067 | Reward status tracking and status API | P0 |
| MIO-068 | Issuance retries, backoff, timeout handling, DLQ and replay | P1 |
| MIO-069 | Wheel fairness: seed management and the anti-manipulation write-up | P1 |
| MIO-070 | ADR: new features (Missions, PvP, Kingdom Builder) consume canonical events only | P1 |
| MIO-206 | Replay of a spin stored under the old raw key after the key format change | P2 |
| MIO-207 | Spin seed secrecy proof and a published commitment for provably fair spins | P2 |
| MIO-208 | Test that tenant creation seeds the default rule and wheel through the real event | P1 |

## Covers

Part A (rules engine, reward redemption and delivery, admin configuration), Part B steps 3 to 8,
Part C (manipulation of probabilities, unauthorized spins), Part E question 3.
