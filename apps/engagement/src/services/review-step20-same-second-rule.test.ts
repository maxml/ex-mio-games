import { DEFAULT_RULE_ID, type RuleDefinition } from '@ex-mio/contracts';
import type { StoredRule } from '../model/repositories';
import type { AdapterConfig } from '../integrations/adapter';
import { createCasinoA } from '../integrations/casino-a.adapter';
import { createCasinoB } from '../integrations/casino-b.adapter';
import { evaluateRules } from './rules.engine';

/*
 * Review STEP20: the intermittent `scripts/demo.sh` step 20 ("Casino A player holds exactly one
 * spin credit", timed out after 40s) in CI runs 45102225003 and 45117946318 attempt 1.
 *
 * Root cause. Casino A's wire format carries the deposit time only as the signature timestamp `ts`,
 * in whole seconds, and the adapter turns it into `occurred_at` = `ts * 1000`
 * (casino-a.adapter.ts:90). A rule version's `active_from` is the publish instant in milliseconds
 * (operator-config.service.ts:51, `new Date()`; the default v1 rule gets the instant engagement
 * consumed `identity.tenant.created`). `evaluateRules` skips a version whose `active_from` is after
 * `occurred_at` (rules.engine.ts:30). So a deposit made AFTER a rule was published, in the same
 * wall-clock second, is judged at the start of that second, before the rule existed. The demo
 * creates tenant A, publishes rule v2 and deposits within ~1.3 s: v2 is skipped in about half of
 * all CI runs (the grant then comes from v1, silently, with `rule_version` 1), and when the v1 seed
 * also landed after the second boundary no version is active, `evaluateRules` returns [], the
 * consumer commits the inbox row with no credit and logs nothing. Casino B sends `sent_at` in
 * milliseconds, which is why step 21 (casino B) never failed. Not caused by de27142 (BUS-RLS).
 *
 * The chain under test is the production one: the real casino adapter's `parseEvent` feeds the
 * real `evaluateRules`. The fix may live in either (or in how `active_from` is stored); the
 * property does not care where.
 *
 * Timestamps are those of the failing run 45117946318 attempt 1 (UTC 2026-11-23): tenant A created
 * 05:37:36.937, projection visible 05:37:37.384 (the v1 seed is between those; 37.150 here),
 * PUT rules 05:37:37.454 (v2), casino-sim deposit 05:37:37.804 (ts = 1795412257), B at 37.835.
 *
 * RED at ea29b40 (committed as `it.failing`, green while the defect is there):
 *   S20-1 the failing run's exact timeline: casino A's deposit gets no grant at all;
 *   S20-2 for every sub-second publish offset, a casino A deposit later in the same second is not
 *         judged by the rule published before it.
 * Mutation (the fix, applied and reverted by the reviewer): at rules.engine.ts:30 compare
 * `active_from` at whole-second precision (`Math.floor(Date.parse(d.active_from) / 1000) * 1000 > at`)
 * -> S20-1 and S20-2 pass, so `it.failing` reports them RED; then turn them into `it`.
 * Green controls, each with its own mutation:
 *   S20-C1 casino B (millisecond `sent_at`), same timeline, is granted by v2;
 *   S20-C2 casino A one second later is granted by v2;
 *   S20-C3 a casino A deposit whose whole second ends before the publish is NOT granted
 *          (delete rules.engine.ts:30 -> RED: a "fix" that drops the window is caught).
 */

const W = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const T = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';

const cfg: AdapterConfig = {
  baseUrl: 'http://casino.test',
  transport: () => Promise.reject(new Error('no I/O in this test')),
  sandbox: false,
};

/** The rule the demo publishes (and the D-27 default): deposit >= 20.00 EUR gives 1 spin. */
const version = (v: number, activeFrom: string): StoredRule => {
  const definition: RuleDefinition = {
    name: 'Deposit 20 EUR, 1 spin',
    trigger: 'deposit.succeeded',
    conditions: { min_amount_minor: 2000, currency: 'EUR' },
    action: { type: 'grant_spins', spins: 1, wheel_id: W },
    active_from: activeFrom,
    active_to: null,
    max_grants_per_player: null,
  };
  return { rule_id: DEFAULT_RULE_ID, version: v, definition };
};

/** What casino-sim sends for casino A at instant `atMs` (casinos.ts: `ts = floor(now / 1000)`). */
function depositA(atMs: number) {
  const raw = JSON.stringify({
    eventId: 'evt-a-1',
    playerId: 'A-PLAYER-77',
    amount: { value: 5000, currency: 'EUR' },
    status: 'SUCCESS',
    ts: Math.floor(atMs / 1000),
  });
  const parsed = createCasinoA(cfg).parseEvent(raw, {});
  if (parsed.kind !== 'deposit') throw new Error(`casino A parse: ${parsed.kind}`);
  return { ...parsed.event, tenant_id: T };
}

/** What casino-sim sends for casino B at instant `atMs` (`sent_at` = ISO with milliseconds). */
function depositB(atMs: number) {
  const raw = JSON.stringify({
    type: 'payment.completed',
    data: { txn_id: 'evt-b-1', customer_ref: 'B-PLAYER-12', amount_cents: 5000, ccy: 'EUR' },
    sent_at: new Date(atMs).toISOString(),
    signature: 'not-checked-by-parse',
  });
  const parsed = createCasinoB(cfg).parseEvent(raw, {});
  if (parsed.kind !== 'deposit') throw new Error(`casino B parse: ${parsed.kind}`);
  return { ...parsed.event, tenant_id: T };
}

const at = (iso: string): number => Date.parse(iso);
const V1_SEED = '2026-11-23T05:37:37.150Z';
const V2_PUT = '2026-11-23T05:37:37.454Z';
const RULES = [version(1, V1_SEED), version(2, V2_PUT)];
const GRANT_V2 = [{ rule_id: DEFAULT_RULE_ID, rule_version: 2, wheel_id: W, spins: 1 }];

describe('review STEP20: a casino A deposit in the second a rule was published', () => {
  it('S20-0 the adapter really drops the sub-second part (the premise of S20-1/2)', () => {
    expect(depositA(at('2026-11-23T05:37:37.804Z')).occurred_at).toBe('2026-11-23T05:37:37.000Z');
    expect(depositB(at('2026-11-23T05:37:37.835Z')).occurred_at).toBe('2026-11-23T05:37:37.835Z');
  });

  // Defect STEP20: green while a same-second deposit misses the rule, RED once a fix lands.
  it('S20-1failing CI timeline: A deposits after v2 is published, v2 grants', () => {
    expect(evaluateRules(RULES, depositA(at('2026-11-23T05:37:37.804Z')), {})).toEqual(GRANT_V2);
  });

  it('S20-2any publish offset: a later deposit in that second is judged by it', () => {
    const second = at('2026-11-23T05:37:37.000Z');
    const missed: number[] = [];
    for (const offset of [1, 100, 250, 454, 500, 750, 998]) {
      const published = new Date(second + offset).toISOString();
      const rules = [version(1, published)];
      const deposit = depositA(second + offset + 1);
      if (evaluateRules(rules, deposit, {}).length !== 1) missed.push(offset);
    }
    expect(missed).toEqual([]);
  });

  it('S20-C1 control: casino B (millisecond sent_at) on the same timeline is granted by v2', () => {
    expect(evaluateRules(RULES, depositB(at('2026-11-23T05:37:37.835Z')), {})).toEqual(GRANT_V2);
  });

  it('S20-C2 control: casino A one whole second later is granted by v2', () => {
    expect(evaluateRules(RULES, depositA(at('2026-11-23T05:37:38.010Z')), {})).toEqual(GRANT_V2);
  });

  it('S20-C3 control: a casino A deposit whose second ends before the publish gets nothing', () => {
    expect(evaluateRules(RULES, depositA(at('2026-11-23T05:37:36.990Z')), {})).toEqual([]);
  });
});
