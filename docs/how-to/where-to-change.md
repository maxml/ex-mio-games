# Where to change: a third casino, a reward type, a rule, a store item

A map for the four changes most likely to be asked for. Each section lists the files, the tests that must stay
green or be extended, and the contract that carries the change. Paths are from the repository root.

## Add a third casino

Contract: the casino reward port in `packages/contracts/src/casino-adapter.ts` (`issueReward`,
`getRewardStatus(ourKey)`; results `issued`, `pending`, `rejected`, `unknown`; a lookup may also return `not_found`).
Decision: [ADR 0008](../adrs/0008-integration-adapters-canonical-model.md).

| Step                                                                                                                                   | File                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write the adapter: signature check, payload schema, mapping to the canonical `deposit.confirmed` event, reward issue and status lookup | new `apps/engagement/src/integrations/casino-c.adapter.ts`, modelled on `casino-a.adapter.ts` (synchronous) or `casino-b.adapter.ts` (ticket, asynchronous) |
| Export an `AdapterEntry` with its `type`, `recoveryMode` (`native_lookup` or replay) and `issueDeadlineMs`                             | the same file; `register()` refuses an entry with neither recovery mode                                                                                     |
| Register it                                                                                                                            | `apps/engagement/src/integrations/registry.ts`, `createDefaultRegistry()`: one `registry.register(casinoCEntry)`                                            |
| Add a profile and a fake casino to the contract suite                                                                                  | `apps/engagement/src/integrations/adapters.contract.test.ts`, the `PROFILES` table; a registered adapter with no profile fails the suite                    |
| Optional: simulate the casino for the demo and compose tests                                                                           | `apps/casino-sim/src/casinos.ts` (routes), `casinos.test.ts`                                                                                                |

Identity needs no change: `platform` is any string (`packages/contracts/src/identity.ts`) and the `:casino` slug in
`PUT /v1/operator/integrations/:casino/reward-api` is any slug. Tests to run: `pnpm --filter @ex-mio/engagement test`
(the contract suite and the redemption saga tests), then `pnpm test:compose` if the casino is added to casino-sim.

## Add a reward type to the wheel

Contract: `RewardSegment` in `packages/contracts/src/ingest.ts`, a discriminated union on `type` (today `coins` and
`nothing`).

1. Add a variant to the union in `packages/contracts/src/ingest.ts`; extend `ingest.contracts.test.ts`.
2. Handle it in `apps/engagement/src/services/spin.service.ts`: any type other than `coins` currently credits 0
   coins, so a new type is silently worth nothing until a branch is added there.
3. If the reward moves money, the payments consumer must credit it (`apps/payments`, the spin-credit path and its
   `D1-*` tests); otherwise nothing changes outside engagement.
4. Spin determinism is covered by the `INV-WHEEL-*` tests; keep them green.

## Add a rule

Contract: `RuleDefinition` (the `trigger` is `z.literal('deposit.succeeded')` today) and `PutRuleRequest` in
`packages/contracts/src/ingest.ts`; the operator writes it with `PUT /v1/operator/rules`.

1. New condition or trigger: extend `RuleDefinition` and `PutRuleRequest`, and their tests in
   `ingest.contracts.test.ts`.
2. Evaluate it in `apps/engagement/src/services/rules.engine.ts`; add cases to `rules.engine.test.ts`.
3. If a new trigger needs a new event, see `docs/CONTRACTS.md` for how events and the outbox are declared.
4. Run `pnpm --filter @ex-mio/engagement test`; the demo (`scripts/demo.sh`, steps 8 and 13) exercises the rule
   over the live stack.

## Add a store item, or a store reward type

A store item is data, not code: the operator creates it with `POST /v1/store/items` (`CreateItemRequest` and
`StoreItem` in `packages/contracts/src/store.ts`). Nothing changes in engagement for a new item.

A new store reward type needs no engagement change either: `reward.type` is forwarded to the casino by the
adapters (`casino-a.adapter.ts`, `casino-b.adapter.ts`). The casino must accept it, so add the acceptance to
`apps/casino-sim/src/casinos.ts` and a case to the adapter contract suite. Redemption behaviour (hold, issue,
release on failure) is covered by the `I-ORDER-*`, `I-CRASH-*` and `I-RELEASE-GATE-*` tests in
`apps/engagement/src/services/`.
