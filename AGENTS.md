# AGENTS.md

Routing only. Each row says where the answer lives; read that file instead of guessing.

## Start here

| You need                                             | Read                                        |
| ---------------------------------------------------- | ------------------------------------------- |
| What the product is and the owner's principles       | `memory/projectBrief.md`                    |
| How the code is layered and the patterns to follow   | `memory/systemPatterns.md`                  |
| A boundary between components (HTTP, events, tenant) | `docs/CONTRACTS.md`                         |
| Why a decision was made, or to record a new one      | `docs/adrs/` (template: `0000-template.md`) |
| Index of everything under `docs/`                    | `docs/README.md`                            |
| How to run the stack and the tests                   | `README.md`                                 |
| Security rules and reporting                         | `SECURITY.md`                               |

## Where code goes

| Change                        | Place                                                                     |
| ----------------------------- | ------------------------------------------------------------------------- |
| An HTTP shape or an event     | `packages/contracts` (zod schema first, then use it)                      |
| Anything tenant-scoped        | use `packages/tenancy`; never read a tenant id from a request body        |
| Publishing or consuming event | `packages/bus` (outbox in the writing transaction, inbox in the consumer) |
| A retried money-like request  | `packages/idempotency`                                                    |
| A UI element                  | `packages/ui`: a Storybook story first, then the component, then the page |
| A product analytics event     | `logProductEvent` from `packages/logger`, called from a service           |
| A service endpoint            | `apps/<service>/src/controllers` -> `services` -> `model` (see patterns)  |
| A database change             | a new migration in `apps/<service>/src/model/migrations`; never edit one  |

## Commands

```sh
pnpm install --frozen-lockfile
pnpm nx run-many -t lint            # eslint, incl. layering and package boundaries
pnpm nx run-many -t typecheck
pnpm nx run-many -t test            # unit tests
docker compose up -d --wait         # whole stack, no external accounts
pnpm test:compose                   # tests against the running stack
docker compose down -v
```

## Rules that are enforced, not advisory

- Layering and package boundaries fail `lint`. Do not disable the rule to pass.
- Tenant tables have row-level security; a query outside a tenant transaction returns nothing.
- Every controller input is parsed with a zod schema before it reaches a service.
- Never commit secrets. Local credentials in compose and `.env.example` are development-only values.
- A change to a contract (`docs/CONTRACTS.md`) needs the contract entry updated in the same commit.
