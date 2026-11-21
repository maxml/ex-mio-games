---
id: MIO-063
title: Server-authoritative deterministic spin
epic: EPIC-07
priority: P0
money_impact: direct
risk_class: concurrency
status: todo
depends_on: [MIO-061, MIO-062, MIO-086]
size: M
---

## Goal

Assignment step 4: the player spins and receives a deterministic, server-authoritative reward from the
configured weighted table.

## Scope

- `POST /v1/spins` with an `Idempotency-Key`; the body names nothing but the credit id (optional).
- Atomic consume: `UPDATE spin_credits SET status='used' WHERE id=$1 AND user_id=$2 AND
  status='available' RETURNING *`; zero rows means 409.
- Outcome = `HMAC(server_seed[version], spin_id)` mapped onto the cumulative weights of the table version.
  The spin row stores seed version, table version, the HMAC value and the segment.
- Spin result and the coin-credit command (MIO-064) are written in one transaction with the outbox.

## Acceptance criteria

- Recomputing the outcome from the stored seed version, table version and spin id gives the same segment.
- Over 1,000,000 simulated spins, each segment's frequency is within 0.5 percentage points of its weight share.
- The request body cannot change the outcome: any extra field is rejected by validation.
- The same `Idempotency-Key` returns the same result and consumes one credit, scoped and stored as in
  MIO-086; `spins.operation_id` is unique, so a replay after the HTTP record expired returns the same spin.
- Crash after the spin transaction commits and before the response: the retry returns the recorded spin;
  the seed version, table version and segment are unchanged and one coin credit command exists.
