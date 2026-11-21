# Submission index

The root [`README.md`](../../README.md) is the entry point: how to run the stack from a clean clone, the service
map, ports and environment, the test commands per suite, the assumptions and the built / partial / next table.
This folder holds the two submission documents that do not belong in the root README.

| File | What it answers |
| --- | --- |
| [`part-c.md`](part-c.md) | Part C: each reliability and security case, its mechanism, its choke point and the tests that pin it; how probability manipulation is prevented |
| [`known-gaps.md`](known-gaps.md) | What is missing: web calls no service answers yet, and the system-level gaps (no missed-event replay, Stripe as an interface only, no production identity provider, Deckhand deploy and Varta wiring described and not run) |

## Where each part of the task is answered

| Part | Answer |
| --- | --- |
| A: architecture | [`docs/architecture/`](../architecture/README.md), [`overview.md`](../architecture/overview.md), [`docs/adrs/`](../adrs/) |
| B: working prototype | the root README, the flows in [`docs/samples/`](../samples/), the service specs in [`docs/specs/`](../specs/) |
| C: reliability and security | [`part-c.md`](part-c.md) and the reliability matrix in the overview |
| D: AI-native development | [`docs/ai/`](../ai/README.md) |
| E: scaling the product, first 90 days, team | [`docs/scaling/`](../scaling/README.md) |
