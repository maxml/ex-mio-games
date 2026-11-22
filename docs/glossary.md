# Glossary

One plain sentence per term, in the order a reader meets them.

- **MIO**: the platform in this repository, which gives online casinos a game layer with a deposit-triggered wheel, virtual coins and a reward store.
- **Tenant / operator**: a casino company that uses MIO; each one is a tenant, and its staff who configure MIO are operators.
- **Player**: a customer of one casino who plays the wheel and spends coins; a player belongs to one tenant.
- **Casino integration**: the adapter that translates one casino's events and reward API into MIO's own format; the two casinos here are simulated.
- **Spin credit**: the right to one wheel spin, granted when a qualifying deposit arrives.
- **Coins**: the virtual currency a spin pays out and the Bonus Store accepts; it has no cash value.
- **Ledger**: the double-entry record of every coin movement, where debits equal credits and the balance cannot go below zero.
- **Bonus Store**: the catalogue where a player exchanges coins for a casino reward.
- **Redemption**: a player's order to exchange coins for one store item.
- **Issuance**: the request MIO sends to the casino to deliver the reward of a redemption, followed until the casino reports a final status.
- **Saga**: a multi-step process, here the redemption, that records each step so it can be retried or reversed after a failure.
- **Sandbox vs production**: two separate environments per tenant, so test events, credits and credentials stay apart from production ones; both run inside the local stack.
- **Idempotency**: sending the same request more than once has the effect of sending it once.
- **Tenant isolation**: one tenant cannot read or change another tenant's data, enforced in the database as well as in the services.
- **Outbox**: a table where a service writes an event in the same transaction as its data, so the event is published once the transaction commits.
- **Message broker**: the RabbitMQ server that carries events between services.
- **Varta**: an observability and analytics platform that collects logs, metrics and product events in one panel; optional and off in the local run.
- **Deckhand**: a deploy tool that releases new versions without downtime (blue-green); optional, and no deploy was run for this repository.
- **The monorepo starter**: the project skeleton this repository was built from, with Nx, shared packages and the service layout.
- **Firebase Auth Emulator**: a local stand-in for Firebase sign-in, so the stack runs without an account.
- **Fake payment provider**: a built-in stand-in for a payment service that confirms payments locally; a Stripe adapter is a stub behind the same interface, and the fake provider is what runs.
- **ADR**: an architecture decision record, a short document that states one decision, its alternatives and its cost.
- **Compose stack**: the nine containers that `docker compose up` starts, the whole system on one machine.
- **Mutation test**: a check that breaks a guard on purpose and confirms that a specific test then fails.
- **Frozen test**: a test written before the code that the coder may not change.
