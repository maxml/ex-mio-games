---
id: MIO-207
title: Spin seed secrecy proof and a published commitment for provably fair spins
epic: EPIC-07
priority: P2
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-063, MIO-069]
size: M
estimate_hours_base: 16
estimate_hours: 20
---

## Goal

The spin outcome is a deterministic function of the server seed and a client-supplied key. That is safe
only while the seed is never revealed. Prove that it is never revealed, and add a commitment so a casino or
a player can later check a spin without trusting us.

## Scope

- A secrecy test: no route, log line, event, error body or database export field contains the seed or a
  value from which it can be derived.
- A published commitment: a hash of each seed version, published before the version is used, and the seed
  revealed only after the version is retired.
- A verifier that takes a spin row, the revealed seed and the weight table version, and recomputes the
  outcome.
- Update ADR 0005 and the fairness write-up (MIO-069).

## Acceptance criteria

- A scan test greps every response schema, event schema and log field for the seed; none holds it. A probe
  run with a canary seed finds it nowhere in service output, logs or the outbox.
- The commitment of the current version is readable through a public route and equals the hash of the seed
  (checked in a test with the retired version's revealed seed).
- The verifier reproduces the stored outcome of 1,000 spins of a retired version, and fails for a changed
  weight table or a changed key.
- A key chosen by the client cannot be ground against the current seed: a test shows that two keys chosen
  to differ only in one character give outcomes that are not predictable without the seed (the distribution
  stays within the table weights over 100,000 draws).
- Mutation: log the seed at start-up. The canary test goes red.

## Notes

Source: the early review of the final integration (finding F13: safe while the seed is never revealed; no
grinding without it) and the fairness decision record, which names a commit-reveal scheme as an alternative
that was not chosen.
