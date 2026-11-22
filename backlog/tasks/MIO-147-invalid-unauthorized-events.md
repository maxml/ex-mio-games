---
id: MIO-147
title: 'Part C: invalid or unauthorized events'
epic: EPIC-14
priority: P1
money_impact: direct
risk_class: guard
status: todo
depends_on: [MIO-054]
size: S
---

## Goal

Prove that only valid, signed, fresh events from a tenant's own casino have any effect.

## Acceptance criteria

For each casino adapter, each case returns the stated code and writes nothing and publishes nothing:

- no signature: 401; wrong signature: 401; signature by another tenant's secret: 401;
- timestamp older than five minutes: 401 `stale`;
- unknown tenant slug: 404;
- valid signature, malformed JSON: 400; schema-invalid body: 422; float amount: 422;
- deposit with status not successful: 200 and ignored (no spins);
- suspended tenant: 402.

Mutation: replace the timing-safe compare with "always true", then the signature tests go red.
