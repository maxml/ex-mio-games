# Sample requests and responses

One `.http` file per flow of the 8-step workflow. Open them in any REST client that reads the `.http` format (VS Code REST Client, JetBrains HTTP Client) or copy the requests into `curl`.

Response blocks marked `captured from scripts/demo.sh` are real output of one clean run (ids are real, tokens and secrets are never shown). A block still marked `expected, to be replaced with captured output` is a shape from the contracts that the run did not capture: the redemption, final status and timeout flows (files 07, 08 and part of 09, which the run could not complete, see the root README known gaps), the deposit acknowledgement bodies (02, 03: the simulator reports only `{"delivered":[200]}`), the operator signup and plan flow (01, whose output is in the script transcript) and a few single cases of 10 and 11. `scripts/demo.sh` runs the whole story and prints each exchange.

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

Conventions: services listen on `localhost` ports 4001 (identity), 4002 (engagement), 4003 (payments), 4004 (casino simulator). Tokens are placeholders (`{{player_token}}`, `{{operator_token}}`); real ones come from the launch and login endpoints. Amounts are integers in minor units.
