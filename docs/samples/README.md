# Sample requests and responses

One `.http` file per flow of the 8-step workflow. Open them in any REST client that reads the `.http` format (VS Code REST Client, JetBrains HTTP Client) or copy the requests into `curl`.

Response blocks marked `captured from scripts/demo.sh` are real output of one clean run (ids are real, tokens and secrets are never shown). A block marked `shape from the contract, not captured` was never captured live: it is derived from the controllers and the zod contracts in `packages/contracts`, so ids and timestamps are placeholders. That covers the final redemption status and the operator review flow (files 07, 08 and part of 09), the deposit acknowledgement bodies (02, 03), the operator setup flow (01) and single cases of 10 and 11. Captured blocks of the redemption flow come from the first recorded run, which predates decision D-27 (see the root README, "Try it"). `scripts/demo.sh` runs the whole story and prints each exchange.

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
