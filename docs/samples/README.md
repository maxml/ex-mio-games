# Sample requests and responses

One `.http` file per flow of the 8-step workflow. Open them in any REST client that reads the `.http` format (VS Code REST Client, JetBrains HTTP Client) or copy the requests into `curl`.

Every response block is marked `expected, to be replaced with captured output`: the shapes come from the service contracts in `packages/contracts`, not from a recorded run. The demo script will overwrite them with real captured output after integration. <!-- verify after integration -->

| File | Flow | Workflow step |
| --- | --- | --- |
| [01-operator-signup-and-plan.http](01-operator-signup-and-plan.http) | Operator signs up, picks a plan | setup |
| [02-casino-a-deposit.http](02-casino-a-deposit.http) | Casino A deposit webhook with signature header | 1, 2, 3 |
| [03-casino-b-deposit.http](03-casino-b-deposit.http) | Casino B deposit webhook, different schema, same logic | 1, 2, 3 |
| [04-spin.http](04-spin.http) | Player spin | 4 |
| [05-balance.http](05-balance.http) | Coin balance after the spin | 5 |
| [06-store-list.http](06-store-list.http) | Bonus Store list | 6 |
| [07-redeem.http](07-redeem.http) | Redeem coins | 6, 7 |
| [08-redemption-status.http](08-redemption-status.http) | Final status of a redemption | 8 |
| [09-idempotent-replay.http](09-idempotent-replay.http) | Duplicate webhook, spin replay, redemption replay | Part C |
| [10-invalid-signature-401.http](10-invalid-signature-401.http) | Bad or missing signature | Part C |
| [11-cross-tenant-404.http](11-cross-tenant-404.http) | One tenant reads another tenant's data | Part C |

Conventions: services listen on `localhost` ports 4001 (identity), 4002 (engagement), 4003 (payments), 4004 (casino simulator). Tokens are placeholders (`{{player_token}}`, `{{operator_token}}`); the demo script obtains real ones from the launch and login endpoints. Amounts are integers in minor units.
