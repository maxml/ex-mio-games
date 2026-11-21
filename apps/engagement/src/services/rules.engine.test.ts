import type { CanonicalDepositEvent, RuleDefinition } from '@ex-mio/contracts';
import type { StoredRule } from '../model/repositories';
import { evaluateRules } from './rules.engine'; // RED: module missing

/**
 * Rules engine (MIO-060): a pure function, table-driven. Signature (docs/specs section 6):
 *   evaluateRules(rules: StoredRule[], event: CanonicalDepositEvent, priorGrants: Record<ruleId, number>)
 *     -> Array<{ rule_id, rule_version, wheel_id, spins }>
 *
 * Mutations:
 *  - `>=` -> `>` on min_amount_minor           -> INV-RULE-THRESHOLD (exact-threshold row).
 *  - ignore `currency`                          -> INV-RULE-CONDITIONS.
 *  - evaluate the newest version, not the one active at occurred_at -> INV-RULE-VERSION-AT-TIME.
 *  - fire every version active at occurred_at (no per-rule_id highest-version pick)
 *                                               -> INV-RULE-ONE-VERSION.
 *  - ignore max_grants_per_player               -> INV-RULE-CAP.
 *  - mutate the inputs / read Date.now()        -> INV-RULE-PURE.
 */

const W = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2c';
const T = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';

const def = (
  over: Partial<RuleDefinition> & { min?: number; spins?: number } = {},
): RuleDefinition => ({
  name: 'r',
  trigger: 'deposit.succeeded',
  conditions: { min_amount_minor: over.min ?? 1000, ...(over.conditions ?? {}) },
  action: { type: 'grant_spins', spins: over.spins ?? 1, wheel_id: W },
  active_from: over.active_from ?? '2026-11-01T00:00:00.000Z',
  active_to: over.active_to ?? null,
  max_grants_per_player: over.max_grants_per_player ?? null,
});
const rule = (rule_id: string, version: number, d: RuleDefinition): StoredRule => ({
  rule_id,
  version,
  definition: d,
});
const event = (over: Partial<CanonicalDepositEvent> = {}): CanonicalDepositEvent => ({
  tenant_id: T,
  source: 'casino-a',
  external_event_id: 'e1',
  type: 'deposit.succeeded',
  external_player_id: 'p1',
  amount_minor: 1000,
  currency: 'EUR',
  occurred_at: '2026-11-15T10:00:00.000Z',
  ...over,
});

describe('evaluateRules', () => {
  it.each([
    ['exactly the threshold grants N', 1000, 3, 3],
    ['one minor unit below grants none', 999, 3, 0],
    ['well above grants N (not proportional)', 1_000_000, 3, 3],
  ])('INV-RULE-THRESHOLD: %s', (_name, amount, spins, expected) => {
    const grants = evaluateRules(
      [rule('r1', 1, def({ min: 1000, spins }))],
      event({ amount_minor: amount }),
      {},
    );
    expect(grants.reduce((n, g) => n + g.spins, 0)).toBe(expected);
  });

  it('INV-RULE-CONDITIONS: a currency condition must match', () => {
    const r = rule('r1', 1, def({ conditions: { min_amount_minor: 1000, currency: 'USD' } }));
    expect(evaluateRules([r], event({ currency: 'EUR' }), {})).toEqual([]);
    expect(evaluateRules([r], event({ currency: 'USD' }), {})).toHaveLength(1);
  });

  it('INV-RULE-WINDOW: active_from is inclusive, active_to is exclusive, judged at occurred_at', () => {
    const r = rule(
      'r1',
      1,
      def({ active_from: '2026-11-10T00:00:00.000Z', active_to: '2026-11-20T00:00:00.000Z' }),
    );
    const at = (s: string) => evaluateRules([r], event({ occurred_at: s }), {}).length;
    expect(at('2026-11-09T23:59:59.999Z')).toBe(0);
    expect(at('2026-11-10T00:00:00.000Z')).toBe(1);
    expect(at('2026-11-19T23:59:59.999Z')).toBe(1);
    expect(at('2026-11-20T00:00:00.000Z')).toBe(0);
  });

  it('INV-RULE-VERSION-AT-TIME: the version active at occurred_at wins, and its number is recorded', () => {
    const v1 = rule(
      'r1',
      1,
      def({
        spins: 1,
        active_from: '2026-11-01T00:00:00.000Z',
        active_to: '2026-11-10T00:00:00.000Z',
      }),
    );
    const v2 = rule('r1', 2, def({ spins: 5, active_from: '2026-11-10T00:00:00.000Z' }));
    const g = (s: string) => evaluateRules([v2, v1], event({ occurred_at: s }), {});
    expect(g('2026-11-05T00:00:00.000Z')).toEqual([
      { rule_id: 'r1', rule_version: 1, wheel_id: W, spins: 1 },
    ]);
    expect(g('2026-11-10T00:00:00.000Z')).toEqual([
      { rule_id: 'r1', rule_version: 2, wheel_id: W, spins: 5 },
    ]);
    expect(g('2026-11-12T00:00:00.000Z')).toEqual([
      { rule_id: 'r1', rule_version: 2, wheel_id: W, spins: 5 },
    ]);
  });

  it('INV-RULE-ONE-VERSION: when two versions of one rule are active at occurred_at, only the highest version grants (no double grant)', () => {
    // v1 was never closed (active_to null); v2 starts 11-10 and overlaps it
    const v1 = rule('r1', 1, def({ spins: 1, active_from: '2026-11-01T00:00:00.000Z' }));
    const v2 = rule('r1', 2, def({ spins: 5, active_from: '2026-11-10T00:00:00.000Z' }));
    const at = (s: string, rules = [v1, v2]) => evaluateRules(rules, event({ occurred_at: s }), {});
    expect(at('2026-11-12T00:00:00.000Z')).toEqual([
      { rule_id: 'r1', rule_version: 2, wheel_id: W, spins: 5 },
    ]);
    expect(at('2026-11-12T00:00:00.000Z', [v2, v1])).toEqual([
      { rule_id: 'r1', rule_version: 2, wheel_id: W, spins: 5 },
    ]); // input order does not matter
    expect(at('2026-11-05T00:00:00.000Z')).toEqual([
      { rule_id: 'r1', rule_version: 1, wheel_id: W, spins: 1 },
    ]);
  });

  it('INV-RULE-CAP: a rule that already fired max_grants_per_player times for the player grants nothing', () => {
    const r = rule('r1', 1, def({ spins: 2, max_grants_per_player: 2 }));
    expect(evaluateRules([r], event(), { r1: 1 })).toHaveLength(1);
    expect(evaluateRules([r], event(), { r1: 2 })).toEqual([]);
    expect(evaluateRules([r], event(), { r1: 7 })).toEqual([]);
  });

  it('INV-RULE-MULTI: independent rules each grant; an unrelated rule does not', () => {
    const a = rule('a', 1, def({ min: 1000, spins: 1 }));
    const b = rule('b', 1, def({ min: 500, spins: 2 }));
    const c = rule('c', 1, def({ min: 5000, spins: 9 }));
    const out = evaluateRules([a, b, c], event({ amount_minor: 1000 }), {});
    expect(out.map((g) => [g.rule_id, g.spins]).sort()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('INV-RULE-PURE: same input, same output; inputs untouched; no clock', () => {
    jest.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    try {
      const rules = [rule('r1', 1, def({ active_to: '2026-12-01T00:00:00.000Z' }))];
      const ev = event();
      const prior = { r1: 0 };
      const snap = JSON.stringify([rules, ev, prior]);
      const first = evaluateRules(rules, ev, prior);
      expect(first).toHaveLength(1); // the 2030 wall clock is past active_to; occurred_at is what counts
      expect(evaluateRules(rules, ev, prior)).toEqual(first);
      expect(JSON.stringify([rules, ev, prior])).toBe(snap);
    } finally {
      jest.useRealTimers();
    }
  });
});
