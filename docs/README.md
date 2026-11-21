# Docs index

Index only: where to go when you need to know something.

| I want to know...                                     | Go here                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| What the product is and the principles behind choices | [`../memory/projectBrief.md`](../memory/projectBrief.md)     |
| The patterns the code follows                         | [`../memory/systemPatterns.md`](../memory/systemPatterns.md) |
| Which boundaries and contracts apply                  | [`CONTRACTS.md`](CONTRACTS.md)                               |
| How payments (coin ledger, billing) must behave       | [`specs/payments.md`](specs/payments.md)                     |
| Why a decision was made (the "why")                   | [`adrs/`](adrs)                                              |
| How to write a new decision record                    | [`adrs/0000-template.md`](adrs/0000-template.md)             |
| How to run the stack, the ports, the tests            | [`../README.md`](../README.md)                               |
| Security rules and how to report a problem            | [`../SECURITY.md`](../SECURITY.md)                           |
| Where an AI agent starts                              | [`../AGENTS.md`](../AGENTS.md)                               |

## Conventions

- Decisions live in [`adrs/`](adrs), numbered, one decision each.
- A cross-component boundary is recorded in [`CONTRACTS.md`](CONTRACTS.md) as a **named contract** (its
  meaning, who provides it, who consumes it), not as a `file:line` dependency.
- Every file under `docs/` is reachable from this index. Add a row when you add a document.
