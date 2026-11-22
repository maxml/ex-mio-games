# Sample requests and responses

One `.http` file per flow of the 8-step workflow. Open them in any REST client that reads the `.http` format (VS Code REST Client, JetBrains HTTP Client) or copy the requests into `curl`.

Response blocks marked `captured from scripts/demo.sh` are real output of one run (ids are real, tokens and secrets are never shown). The blocks that name a date come from the run of 2026-11-22 on commit `dd9d464` (40 steps, 194 assertions passed; the trimmed run is in the root README). Their requests use the same method, path and body shape as the run; names such as the tenant slug differ, and each block says so where it matters. The older captured blocks (spin, replay, signature and a few isolation cases) come from the first recorded run, which predates decision D-27. A block marked `shape from the contract, not captured` was not found in the demo output with that exact request and response: it is derived from the controllers and the zod contracts in `packages/contracts`, so ids and timestamps are placeholders. That covers the operator review flow and the NEEDS_REVIEW list (07, 08), the deposit acknowledgement bodies (02, 03: the demo drives deposits through the simulator, not by calling the webhook directly), the player launch (02), single cases of 04, 09, 10 and 11, and the item create and refusal cases (06). `scripts/demo.sh` runs the whole story and prints each exchange.

| File                                                                 | Flow                                                   | Workflow step |
| -------------------------------------------------------------------- | ------------------------------------------------------ | ------------- |
| [01-operator-signup-and-plan.http](01-operator-signup-and-plan.http) | Operator signs up, picks a plan                        | setup         |
| [02-casino-a-deposit.http](02-casino-a-deposit.http)                 | Casino A deposit webhook with signature header         | 1, 2, 3       |
| [03-casino-b-deposit.http](03-casino-b-deposit.http)                 | Casino B deposit webhook, different schema, same logic | 1, 2, 3       |
| [04-spin.http](04-spin.http)                                         | Player spin                                            | 4             |
| [05-balance.http](05-balance.http)                                   | Coin balance after the spin                            | 5             |
| [06-store-list.http](06-store-list.http)                             | Bonus Store list                                       | 6             |
| [07-redeem.http](07-redeem.http)                                     | Redeem coins                                           | 6, 7          |
| [08-redemption-status.http](08-redemption-status.http)               | Final status of a redemption                           | 8             |
| [09-idempotent-replay.http](09-idempotent-replay.http)               | Duplicate webhook, spin replay, redemption replay      | Part C        |
| [10-invalid-signature-401.http](10-invalid-signature-401.http)       | Bad or missing signature                               | Part C        |
| [11-cross-tenant-404.http](11-cross-tenant-404.http)                 | One tenant reads another tenant's data                 | Part C        |

Conventions: services listen on `localhost` ports 4001 (identity), 4002 (engagement), 4003 (payments), 4004 (casino simulator). Tokens are placeholders. A **player** token comes from `POST /v1/auth/launch` (file 02) and is valid for identity, engagement and payments, so `{{player_token}}` works everywhere. An **operator** token comes from `POST /v1/auth/login` (file 01) and has exactly one audience, so each service needs its own login: `{{operator_identity_token}}`, `{{operator_engagement_token}}`, `{{operator_payments_token}}`. A token for the wrong audience is refused with 401. Internal routes (`/internal/v1/...`) take service tokens only. Amounts are integers in minor units. The files start at a tenant that signs up in 01; a new tenant already has a default wheel (200/300/500) and a deposit rule.
