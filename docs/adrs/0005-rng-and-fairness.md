# 0005. Server-authoritative RNG and wheel fairness

Diagram: section [2](../../docs/architecture/README.md#2-sequence-the-8-step-workflow) of the diagram hub (why each diagram exists: [table](../../docs/architecture/README.md#why-each-diagram-exists)).

- Status: accepted
- Deciders: product owner (maxml), architecture session
- Date: 2026-11-21
- Confidence: medium-high

## Context and problem statement

The brief requires a "deterministic, server-authoritative reward selected from a configured weighted reward table", and asks how players are prevented from manipulating probabilities or triggering unauthorized spins. Deterministic here means reproducible from stored inputs, not predictable by the player.

## Decision drivers

- The client must have no influence over the outcome.
- A result must be reproducible by an auditor from stored data.
- A spin credit must be usable once, even under concurrent requests.
- Operators change weights; a past result must still be explainable.

## Considered options

1. `Math.random()` on the server.
2. A keyed hash of a secret server seed and the spin id, mapped onto the weight table.
3. Commit-reveal provably fair scheme with a client seed.

## Decision outcome

Option 2.

- Outcome = `HMAC-SHA256(server_seed[version], spin_id)`, reduced to an integer in `[0, total_weight)` by taking the first 48 bits and scaling them (`roll * total_weight >> 48`, no modulo; the residual bias is below `total_weight / 2^48`, and the total is capped), then looked up in the cumulative weight table.
- The weight table is versioned and immutable once used. The spin row stores the table version and seed version, so any result can be recomputed.
- The seed is a server secret, never sent to a client. Weights are not exposed to players either.
- A spin credit is a row. Consuming it is `UPDATE ... SET status = 'used' WHERE id = ? AND status = 'available' RETURNING`. Of N concurrent requests, one gets a row and the others get a conflict.
- Credits are created only by the processing of a validated, deduplicated deposit event (ADR 0003, 0008). No API creates a credit on a player's request.
- The spin endpoint authenticates the player, authorizes ownership of the credit, and takes the tenant from the verified session.
- The reward coins are credited by `payments`, not by the spin endpoint: engagement writes `spin.completed` to its outbox in the spin's transaction and payments credits with the key `spin:<spin_id>` from its inbox, so a retry cannot pay twice.
- Spin credits are scoped to an environment (sandbox or production); a sandbox token cannot consume a production credit.

### Consequences

Good: results are reproducible, the player has no input, concurrency is settled by a single conditional update.

Bad: players cannot verify fairness themselves (no commit-reveal); a leaked seed breaks fairness, so seed rotation by version is required. If a regulator requires player-verifiable fairness, option 3 is the upgrade path.

## Pros and cons of the options

- Option 1: not reproducible and not auditable.
- Option 3: stronger trust story, but needs client participation and UI, which is out of scope for the slice.

## Built vs designed

- Built: option 2, versioned tables, one-use credits, tests for concurrent spins and distribution.
- Designed only: seed rotation operations, commit-reveal.
